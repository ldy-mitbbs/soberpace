const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'soberpace-super-secret-key-neon-drink-99';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// SQLite Database Setup (configurable via env for container volumes)
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Failed to open database:', err.message);
    } else {
        console.log('Connected to SQLite database at:', dbPath);
        initDatabase();
    }
});

// Promise Helpers for SQLite
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

// Create tables
async function initDatabase() {
    try {
        // 1. Users Table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                gender TEXT DEFAULT 'male',
                age INTEGER DEFAULT 40,
                weight REAL DEFAULT 125.0,
                weight_unit TEXT DEFAULT 'lbs',
                height REAL DEFAULT 172.0,
                height_unit TEXT DEFAULT 'cm',
                target_bac_limit REAL DEFAULT 0.060,
                pacing_time INTEGER DEFAULT 60,
                pacing_mode TEXT DEFAULT 'auto',
                global_stomach TEXT DEFAULT 'normal',
                decay_rate REAL DEFAULT 0.015,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Active Session Drinks Table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS drinks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                drink_id_client INTEGER NOT NULL,
                name TEXT NOT NULL,
                volume REAL NOT NULL,
                abv REAL NOT NULL,
                alcohol_grams REAL NOT NULL,
                time INTEGER NOT NULL,
                stomach TEXT NOT NULL,
                duration INTEGER DEFAULT 0,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Migration: Check and add duration column if it does not exist
        try {
            await dbRun("ALTER TABLE drinks ADD COLUMN duration INTEGER DEFAULT 0");
            console.log("Migration: 'duration' column verified/added to table 'drinks'.");
        } catch (e) {
            // Safe to ignore if column already exists
        }

        // Migration: Check and add pacing_mode column if it does not exist
        try {
            await dbRun("ALTER TABLE users ADD COLUMN pacing_mode TEXT DEFAULT 'auto'");
            console.log("Migration: 'pacing_mode' column verified/added to table 'users'.");
        } catch (e) {
            // Safe to ignore if column already exists
        }

        // 3. Archives Table
        await dbRun(`
            CREATE TABLE IF NOT EXISTS archives (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                archive_id_client INTEGER NOT NULL,
                date TEXT NOT NULL,
                peak_bac REAL NOT NULL,
                duration REAL NOT NULL,
                drinks_json TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        console.log('Database tables verified/created successfully.');
    } catch (err) {
        console.error('Error initializing database tables:', err.message);
    }
}

// Authentication Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Access denied. Token missing.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token is invalid or expired.' });
        }
        req.user = user;
        next();
    });
}

// --- AUTHENTICATION ROUTES ---

// Registration Route
app.post('/api/register', async (req, res) => {
    const { username, password, gender, age, weight, weightUnit, height, heightUnit } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空。' });
    }

    try {
        // Check if user exists
        const userExists = await dbGet('SELECT id FROM users WHERE username = ?', [username.toLowerCase().trim()]);
        if (userExists) {
            return res.status(400).json({ error: '该用户名已被注册。' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Save new user
        const result = await dbRun(
            `INSERT INTO users (username, password_hash, gender, age, weight, weight_unit, height, height_unit) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                username.toLowerCase().trim(),
                passwordHash,
                gender || 'male',
                parseInt(age) || 40,
                parseFloat(weight) || 125.0,
                weightUnit || 'lbs',
                parseFloat(height) || 172.0,
                heightUnit || 'cm'
            ]
        );

        // Generate JWT
        const token = jwt.sign({ id: result.id, username: username.toLowerCase().trim() }, JWT_SECRET, { expiresIn: '30d' });
        
        res.status(201).json({
            message: '注册成功！',
            token: token,
            username: username
        });
    } catch (err) {
        console.error('Registration error:', err.message);
        res.status(500).json({ error: '服务器内部错误，请稍后再试。' });
    }
});

// Login Route
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '用户名和密码不能为空。' });
    }

    try {
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username.toLowerCase().trim()]);
        if (!user) {
            return res.status(400).json({ error: '用户名或密码不正确。' });
        }

        // Compare password
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(400).json({ error: '用户名或密码不正确。' });
        }

        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

        res.json({
            message: '登录成功！',
            token: token,
            username: user.username
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: '服务器内部错误，请稍后再试。' });
    }
});

// --- USER PROFILE ROUTES ---

// Get Profile settings
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = await dbGet(
            `SELECT gender, age, weight, weight_unit as weightUnit, height, height_unit as heightUnit, 
                    target_bac_limit as targetBacLimit, pacing_time as pacingTime, pacing_mode as pacingMode, 
                    global_stomach as globalStomach, decay_rate as decayRate 
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!user) {
            return res.status(404).json({ error: '未找到该用户配置。' });
        }
        res.json(user);
    } catch (err) {
        console.error('Get profile error:', err.message);
        res.status(500).json({ error: '数据库查询错误。' });
    }
});

// Update Profile settings
app.put('/api/profile', authenticateToken, async (req, res) => {
    const { gender, age, weight, weightUnit, height, heightUnit, targetBacLimit, pacingTime, pacingMode, globalStomach, decayRate } = req.body;

    try {
        await dbRun(
            `UPDATE users 
             SET gender = ?, age = ?, weight = ?, weight_unit = ?, height = ?, height_unit = ?, 
                 target_bac_limit = ?, pacing_time = ?, pacing_mode = ?, global_stomach = ?, decay_rate = ? 
             WHERE id = ?`,
            [
                gender,
                parseInt(age),
                parseFloat(weight),
                weightUnit,
                parseFloat(height),
                heightUnit,
                parseFloat(targetBacLimit),
                parseInt(pacingTime),
                pacingMode || 'auto',
                globalStomach,
                parseFloat(decayRate),
                req.user.id
            ]
        );
        res.json({ message: '个人指标配置已同步更新。' });
    } catch (err) {
        console.error('Update profile error:', err.message);
        res.status(500).json({ error: '无法保存个人指标配置。' });
    }
});

// --- ACTIVE DRINKS ROUTES ---

// Get all active drinks
app.get('/api/drinks', authenticateToken, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT drink_id_client as id, name, volume as vol, abv, alcohol_grams as alcoholGrams, time, stomach, duration 
             FROM drinks 
             WHERE user_id = ? 
             ORDER BY time ASC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        console.error('Get drinks error:', err.message);
        res.status(500).json({ error: '获取饮酒记录失败。' });
    }
});

// Log a drink
app.post('/api/drinks', authenticateToken, async (req, res) => {
    const { id, name, vol, abv, alcoholGrams, time, stomach, duration } = req.body;

    try {
        await dbRun(
            `INSERT INTO drinks (user_id, drink_id_client, name, volume, abv, alcohol_grams, time, stomach, duration) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, id, name, vol, abv, alcoholGrams, time, stomach, duration || 0]
        );
        res.status(201).json({ message: '饮酒记录已保存。' });
    } catch (err) {
        console.error('Log drink error:', err.message);
        res.status(500).json({ error: '记录饮酒失败。' });
    }
});

// Clear all active drinks for user
app.delete('/api/drinks', authenticateToken, async (req, res) => {
    try {
        await dbRun('DELETE FROM drinks WHERE user_id = ?', [req.user.id]);
        res.json({ message: '当前活动饮酒记录已全部清空。' });
    } catch (err) {
        console.error('Clear active drinks error:', err.message);
        res.status(500).json({ error: '清空活动饮酒记录失败。' });
    }
});

// Delete a drink
app.delete('/api/drinks/:id', authenticateToken, async (req, res) => {
    const drinkIdClient = req.params.id;

    try {
        const result = await dbRun('DELETE FROM drinks WHERE user_id = ? AND drink_id_client = ?', [req.user.id, drinkIdClient]);
        if (result.changes === 0) {
            return res.status(404).json({ error: '未找到指定饮酒记录。' });
        }
        res.json({ message: '饮酒记录已删除。' });
    } catch (err) {
        console.error('Delete drink error:', err.message);
        res.status(500).json({ error: '删除记录失败。' });
    }
});

// --- SESSION ARCHIVE ROUTES ---

// Get session archives
app.get('/api/archives', authenticateToken, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT archive_id_client as id, date, peak_bac as peakBac, duration, drinks_json as drinks 
             FROM archives 
             WHERE user_id = ? 
             ORDER BY id DESC`,
            [req.user.id]
        );
        
        // Parse drinks_json strings back into javascript objects
        const formattedRows = rows.map(row => {
            try {
                row.drinks = JSON.parse(row.drinks);
            } catch (e) {
                row.drinks = [];
            }
            return row;
        });

        res.json(formattedRows);
    } catch (err) {
        console.error('Get archives error:', err.message);
        res.status(500).json({ error: '获取历史存档失败。' });
    }
});

// Archive current session
app.post('/api/archives', authenticateToken, async (req, res) => {
    const { id, date, peakBac, duration, drinks } = req.body;

    try {
        // Begin SQLite Transaction
        db.serialize(async () => {
            // Save to archives table
            db.run(
                `INSERT INTO archives (user_id, archive_id_client, date, peak_bac, duration, drinks_json) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [req.user.id, id, date, peakBac, duration, JSON.stringify(drinks)],
                function(err) {
                    if (err) {
                        console.error('Archive insertion failed:', err.message);
                    }
                }
            );

            // Delete user's active drinks (resets session)
            db.run('DELETE FROM drinks WHERE user_id = ?', [req.user.id], function(err) {
                if (err) {
                    console.error('Reset session drinks failed:', err.message);
                }
            });
        });

        res.status(201).json({ message: '会话已打包并归档，主页已重置。' });
    } catch (err) {
        console.error('Archive session error:', err.message);
        res.status(500).json({ error: '打包归档失败。' });
    }
});

// Clear all user archives
app.delete('/api/archives', authenticateToken, async (req, res) => {
    try {
        await dbRun('DELETE FROM archives WHERE user_id = ?', [req.user.id]);
        res.json({ message: '历史记录已清空。' });
    } catch (err) {
        console.error('Clear archives error:', err.message);
        res.status(500).json({ error: '清空历史记录失败。' });
    }
});

// Delete a single user archive
app.delete('/api/archives/:id', authenticateToken, async (req, res) => {
    const archiveIdClient = req.params.id;

    try {
        const result = await dbRun('DELETE FROM archives WHERE user_id = ? AND archive_id_client = ?', [req.user.id, archiveIdClient]);
        if (result.changes === 0) {
            return res.status(404).json({ error: '未找到指定归档记录。' });
        }
        res.json({ message: '归档记录已删除。' });
    } catch (err) {
        console.error('Delete archive error:', err.message);
        res.status(500).json({ error: '删除归档记录失败。' });
    }
});

// Catch-all route to serve PWA static assets
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start listening
app.listen(PORT, () => {
    console.log(`================================================`);
    console.log(` SoberPace Server running locally at:           `);
    console.log(` http://localhost:${PORT}                       `);
    console.log(`================================================`);
});
