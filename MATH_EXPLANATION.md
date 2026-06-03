# SoberPace 酒精代谢算法与控速原理数学推导

本项目使用 **双室动力学吸收模型（Double-Compartment Kinetics）** 和 **Widmark-Watson 算法** 来高精度地模拟人体血液酒精浓度（BAC）的上升与下降过程，并基于零级消除动力学（Zero-Order Elimination Kinetics）进行智能控速计算。

以下是项目中所有核心公式的微积分推导与数理解析。

---

## 1. 酒精吸收模型：双室动力学（Stomach ➔ Blood）

在传统的简化 Widmark 模型中，通常假设“酒精是瞬间吸收的（Instant Absorption）”。但在实际饮酒中，酒精首先进入胃部（第一室），然后以一级速率常数 $k_a$ 被小肠和胃壁吸收进入血液（第二室），同时饮酒本身需要一定的时间 $T$。

我们将饮酒过程建模为：在饮用时长 $T$ (小时) 内，酒精以恒定速率 $R$ (克/小时) 注入胃部。若饮入的酒精总质量为 $M_{\text{alc}}$ (克)，则：
- 注入速率 $R = \frac{M_{\text{alc}}}{T}$
- 在 $t > T$ 后，酒精停止注入，即 $R = 0$。

### 1.1 胃部酒精质量 $A_s(t)$ 的常微分方程

根据物质守恒定律，胃部酒精随时间的变化率等于注入率减去吸收率：
$$\frac{dA_s}{dt} = R - k_a A_s(t)$$

这是一个一阶线性非齐次常微分方程，初值条件为 $A_s(0) = 0$。我们使用**积分因子法**求解：
将方程重写为：
$$\frac{dA_s}{dt} + k_a A_s(t) = R$$

积分因子为 $I(t) = e^{\int k_a dt} = e^{k_a t}$。方程两边同乘 $e^{k_a t}$：
$$\frac{d}{dt} \left( A_s(t) e^{k_a t} \right) = R e^{k_a t}$$

#### 【情况 A】在饮酒期间 ($t \le T$)
对两边从 $0$ 到 $t$ 积分：
$$A_s(t) e^{k_a t} - 0 = \int_0^t R e^{k_a \tau} d\tau = \frac{R}{k_a} (e^{k_a t} - 1)$$
$$A_s(t) = \frac{R}{k_a} (1 - e^{-k_a t}) \quad (t \le T)$$

#### 【情况 B】饮酒结束后 ($t > T$)
在 $t = T$ 时刻，胃部积累的酒精量为：
$$A_s(T) = \frac{R}{k_a} (1 - e^{-k_a T})$$
当 $t > T$ 时，由于不再有新的酒注入 ($R = 0$)，胃部方程退化为齐次方程 $\frac{dA_s}{dt} + k_a A_s = 0$，其解为指数衰减：
$$A_s(t) = A_s(T) e^{-k_a (t - T)} = \frac{R}{k_a} (1 - e^{-k_a T}) e^{k_a T} e^{-k_a t}$$
$$A_s(t) = \frac{R}{k_a} (e^{k_a T} - 1) e^{-k_a t} \quad (t > T)$$

---

### 1.2 累积吸收酒精质量 $A_{\text{absorbed}}(t)$ 的推导

血液吸收酒精的速率等于胃部酒精的流出速率：
$$\frac{dA_{\text{absorbed}}}{dt} = k_a A_s(t)$$
因此，从 $0$ 到 $t$ 的累积吸收量为胃部酒精量的积分：
$$A_{\text{absorbed}}(t) = \int_0^t k_a A_s(\tau) d\tau$$

#### 【积分求解 A】饮酒期间 ($t \le T$)
$$A_{\text{absorbed}}(t) = \int_0^t k_a \left[ \frac{R}{k_a} (1 - e^{-k_a \tau}) \right] d\tau = R \int_0^t (1 - e^{-k_a \tau}) d\tau$$
$$A_{\text{absorbed}}(t) = R \left[ \tau + \frac{1}{k_a} e^{-k_a \tau} \right]_0^t = R \left[ t + \frac{e^{-k_a t} - 1}{k_a} \right]$$
将 $R = \frac{M_{\text{alc}}}{T}$ 代入，得到**正在饮酒时的累积吸收公式**：
$$A_{\text{absorbed}}(t) = M_{\text{alc}} \left[ \frac{t}{T} - \frac{1 - e^{-k_a t}}{k_a T} \right] \quad (t \le T)$$

#### 【积分求解 B】饮酒结束后 ($t > T$)

我们可以将积分分成两段：

$$A_{\text{absorbed}}(t) = A_{\text{absorbed}}(T) + \int_T^t k_a A_s(\tau) d\tau$$

首先代入 $t = T$ 算出前半段的吸收量：

$$A_{\text{absorbed}}(T) = M_{\text{alc}} \left[ 1 - \frac{1 - e^{-k_a T}}{k_a T} \right]$$

然后计算第二段积分 ($t > T$ 后胃内残留酒精的吸收量)：

$$\int_T^t k_a \left[ \frac{R}{k_a} (e^{k_a T} - 1) e^{-k_a \tau} \right] d\tau = R (e^{k_a T} - 1) \int_T^t e^{-k_a \tau} d\tau$$

$$= R (e^{k_a T} - 1) \left[ -\frac{1}{k_a} e^{-k_a \tau} \right]_T^t = \frac{R(e^{k_a T} - 1)}{k_a} (e^{-k_a T} - e^{-k_a t})$$

由于 $R = \frac{M_{\text{alc}}}{T}$，且 $(e^{k_a T} - 1)e^{-k_a T} = 1 - e^{-k_a T}$，代入展开后：

$$= M_{\text{alc}} \left[ \frac{1 - e^{-k_a T}}{k_a T} - \frac{e^{k_a T} - 1}{k_a T} e^{-k_a t} \right]$$

将两部分加起来（注意中间项恰好相消）：

$$A_{\text{absorbed}}(t) = M_{\text{alc}} \left[ 1 - \frac{e^{k_a T} - 1}{k_a T} e^{-k_a t} \right] \quad (t > T)$$

这两段分段积分公式，就是本项目中 [app.js](file:///Users/fanglin/code/soberpace/app.js) 里进行 minute-by-minute 仿真计算酒精吸收量所使用的核心数学基础。

---

## 2. 血液酒精浓度（BAC）计算：Widmark-Watson 理论

人体吸收了酒精后，酒精会迅速扩散到体液（全身水分）中。

### 2.1 经典 Widmark 公式
$$BAC(t) = \frac{A_{\text{absorbed}}(t) - A_{\text{eliminated}}(t)}{W \times r \times 10}$$
- $BAC(t)$ ：血液酒精浓度 (%，单位为 g/100mL 血液)。
- $W$ ：体重 (kg)。
- $r$ ：Widmark 因子，即酒精在体内的分布系数 (全身水分体积分数与血液中水分体积分数的比值)。
- 分母上的 10 是由于单位换算（g/kg 转换为 g/100mL 血液，需要除以 10）。

### 2.2 Watson 动态水分校正 (Watson $r$ 因子)
Widmark 因子 $r$ 在传统计算中男女分别固定为 `0.68` 和 `0.55`。但由于每个人的体脂率不同，全身水分占比（TBW，Total Body Water）千差万别。本项目引入 **Watson 经验公式** 计算人体的全身水分体积 (升)：

- **男性 Watson 公式**：
  $$TBW_{\text{male}} = 2.447 - 0.09516 \times \text{Age} + 0.1074 \times \text{Height(cm)} + 0.3362 \times \text{Weight(kg)}$$
- **女性 Watson 公式**：
  $$TBW_{\text{female}} = -2.097 + 0.1069 \times \text{Height(cm)} + 0.2466 \times \text{Weight(kg)}$$

因为血液的含水量约为 80% (即分布容积 $V_d = \frac{TBW}{0.8}$)，根据 Widmark 定义，酒精在全血中的分配系数 $r$ 可以表示为：
$$r = \frac{V_d}{W} = \frac{TBW}{0.8 \times W}$$
这个动态计算出的 $r$ 能够极大程度地根据用户的年龄、身高、体重进行个性化拟合。

---

## 3. 酒精清除模型：零级动力学

酒精在肝脏中的代谢由乙醇脱氢酶（ADH）主导。因为在正常饮酒浓度下，酶的活性中心几乎是完全饱和的，所以酒精的消除速度**不随血液酒精浓度的变化而变化**，这在药代动力学中被称为**零级消除动力学（Zero-Order Elimination Kinetics）**。

### 3.1 清除公式
$$A_{\text{eliminated}}(t) = \beta \times W \times r \times 10 \times t_{\text{hours}}$$
对应 BAC 的衰减为线性衰减：
$$\frac{d(BAC)}{dt} = -\beta \quad (\text{当 } BAC > 0)$$
其中 $\beta$ 是每小时的酒精衰减率（例如 `0.015%` BAC / 小时）。在软件中，每个时间步长（1分钟）的清除量为：
$$\Delta BAC_{\text{clear}} = \frac{\beta}{60} \quad (\text{分钟})$$

---

## 4. 智能控速物理间隔计算原理

当用户开启“智能计算（推荐）”时，系统需要给出一个安全的物理间隔时间 $I$ (分钟)。

### 4.1 稳态极值极限推导（理想极速计算）
假设用户无限循环地以 $I$ 小时为间隔，每间隔饮用一杯带来 $\Delta BAC$ 增幅的酒。
在零级代谢下，要使体内酒精不无限累积，**单杯酒增加的酒精量必须等于该时间间隔内肝脏代谢掉的酒精量**：
$$\Delta BAC = \beta \times I_{\text{hours}}$$
解出达到代谢平衡的理论间隔：
$$I_{\text{hours}} = \frac{\Delta BAC}{\beta}$$
换算成分钟：
$$I_{\text{mins}} = \frac{14}{W \times r \times 10 \times \beta} \times 60$$

### 4.2 峰值约束下的仿真搜索算法（本项目采用）
上面的理论公式假定吸收是瞬时的且没有峰值约束。然而实际吸收有滞后性 (由 $k_a$ 控制)，因此如果用户以 $I$ 为间隔连续饮酒，短时间内的吸收波峰可能会超出安全上限 $C_{\text{target}}$ (如 `0.06%`)。

为了计算出绝对安全的间隔，项目在后台运行了一套仿真算法：
1. 测试间隔时间 $I \in [30, 360]$ 分钟 (步长 5 分钟)。
2. 在该间隔 $I$ 下，模拟用户在 $t = 0, I, 2I, 3I$ 时刻连续喝下 4 杯标准饮品（14g 酒精，饮用 25 分钟）。
3. 运行微积分仿真引擎，记录 6 小时内体内的最高 BAC 峰值 $BAC_{\text{max}}$。
4. 找到使 $BAC_{\text{max}} \le C_{\text{target}}$ 的**最小间隔时间 $I$**。

通过这种仿真法，App 将体重、性别、吸收速率 $k_a$ (胃部状态) 和消除速率 $\beta$ 统一在一个动力学框架内，计算出了兼顾**代谢平稳**与**短期峰值不超标**的科学饮酒间隔。
