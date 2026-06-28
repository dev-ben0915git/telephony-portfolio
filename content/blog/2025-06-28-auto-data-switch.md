---
title: "Android 双卡数据自动切换（AutoDataSwitchController）全流程分析"
date: "2025-06-28"
summary: "从信号变化触发评估到自动切换完成的完整流程分析，涵盖 AutoDataSwitchController 评分机制、9 种触发原因、稳定性检查定时器、Ping 验证与指数退避重试、自动回退机制及 CarrierConfig/DeviceConfig 配置体系。"
category: "data-service"
tags: ["AutoDataSwitchController", "PhoneSwitcher", "PhoneSignalStatus", "ScoreTolerance", "comparePhones", "UsableState", "RatSignalScore", "StabilityCheck", "PingTest", "CarrierConfig", "DeviceConfig", "OPPT", "AutoDataSwitch"]
featured: true
---

## 1 概述

在 Android 双卡双待（DSDS）设备中，除了用户主动切换默认数据卡（DDS）外，系统还具备**自动数据切换**能力：当一张 SIM 卡信号恶化或另一张改善时，系统自动将数据路由临时切换到更优的 SIM 卡。

自动数据切换由 `AutoDataSwitchController` 负责，它与手动 DDS 切换有本质区别：

| 维度 | 手动 DDS 切换 | 自动数据切换 |
|------|-------------|-------------|
| 触发源 | 用户操作 Settings / API 调用 | 系统自动监控信号变化、注册状态变化 |
| DDS 是否改变 | 改变 `mPrimaryDataSubId`（持久化） | **不改变** DDS，仅临时使用 `mAutoSelectedDataSubId` |
| 决策依据 | 用户主观选择 | 客观信号/RAT 评分对比 + ScoreTolerance 容差 |
| 切换前检查 | 无稳定性检查，立即执行 | 需经过稳定性检查定时器，不会立即切换 |
| 回退机制 | 无自动回退，用户需手动切回 | 条件不满足时自动回到用户设定的 DDS |

### 整体架构

```
信号变化 / 注册状态变化 / 网络类型变化 / ...
  │
  ▼
AutoDataSwitchController.evaluateAutoDataSwitch(reason)
  │
  ├→ readCarrierConfigIfNeeded()         // 刷新配置
  ├→ onEvaluateAutoDataSwitch(reason)      // 核心评估
  │    │
  │    ├→ evaluateSwitchToTarget()         // 默认卡 -> 备卡
  │    │    └→ comparePhones()             // 评分对比
  │    │         └→ startStabilityCheck()  // 稳定性检查定时器
  │    │              │
  │    │              ├→ [短超时] Handler.postDelayed
  │    │              └→ [长超时] AlarmManager
  │    │                   │
  │    │                   ▼
  │    │              callback.onRequireValidation()  // Ping 验证
  │    │                   │
  │    │                   ▼
  │    │              PhoneSwitcher / ConnectivityManager
  │    │                   │
  │    │              验证成功 → callback.onRequireImmediatelySwitchToPhone()
  │    │              验证失败 → 指数退避重试
  │    │
  │    └→ evaluateSwitchOutOfTarget()     // 备卡 -> 更优卡 / 回退
  │         └→ comparePhones()
  │              ├→ 找到更优 → startStabilityCheck()
  │              └→ 未找到 → cancelAnyPendingSwitch()  // 自动回退
  │
  └→ PhoneSwitcher（执行实际切换）
       └→ DataNetworkController（建立/拆除数据网络）
```

### 9 种触发原因速览

| 触发原因 | 说明 |
|---------|------|
| `REGISTRATION_STATE_CHANGED` | PS 域注册状态变化（有服务 / 无服务） |
| `DISPLAY_INFO_CHANGED` | TelephonyDisplayInfo 变化（5G NSA/mmWave 等） |
| `SIGNAL_STRENGTH_CHANGED` | 信号等级变化 |
| `DEFAULT_NETWORK_CHANGED` | 默认网络能力变化或丢失 |
| `DATA_SETTINGS_CHANGED` | 数据设置变化（开关数据） |
| `RETRY_VALIDATION` | 验证失败后重试 |
| `SIM_LOADED` | SIM 卡加载完成 |
| `VOICE_CALL_END` | 语音通话结束 |
| `CARRIER_CONFIG_CHANGED` | 运营商配置变化 |

## 2 核心类与数据结构

### AutoDataSwitchController 类头

```java
// packages/services/Telephony/src/java/com/android/internal/telephony/data/AutoDataSwitchController.java
public class AutoDataSwitchController extends Handler {
    // 约 1664 行，继承 Handler 以便异步调度评估事件
}
```

### 核心字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `mPhonesSignalStatus` | `PhoneSignalStatus[]` | 每个 Phone 的信号状态追踪数组 |
| `mSelectedTargetPhoneId` | `int` | 当前候选切换目标 PhoneId（stickyTarget），裁剪频繁评估范围 |
| `mScoreTolerance` | `int` | 自动切换的分数容差阈值；≤0 表示禁用基于 RAT/信号的切换 |
| `mRequirePingTestBeforeSwitch` | `boolean` | 切换前是否需要 Ping 验证通过 |
| `mAutoSwitchValidationFailedCount` | `int` | 连续验证失败计数 |
| `mAutoDataSwitchValidationMaxRetry` | `int` | 最大验证重试次数 |
| `mDefaultNetworkIsOnNonCellular` | `boolean` | 当前默认网络是否在非蜂窝传输上 |
| `mPhoneSwitcher` | `PhoneSwitcher` | PhoneSwitcher 引用，用于获取首选数据 PhoneId |
| `mPhoneSwitcherCallback` | `AutoDataSwitchControllerCallback` | 回调接口，通知 PhoneSwitcher 执行/取消切换 |
| `mDisplayedNotification` | `boolean` | 是否已显示过自动切换通知 |

### PhoneSignalStatus 内部类

追踪每个 Phone 的信号状态，是评分机制的数据来源：

```java
private static class PhoneSignalStatus {
    int mDataRegState;         // PS 域注册状态
    TelephonyDisplayInfo mDisplayInfo;  // 网络显示信息（含 5G 状态）
    SignalStrength mSignalStrength;     // 信号强度
    boolean mListeningForEvents;         // 是否正在监听事件

    int getRatSignalScore() { ... }    // 获取 RAT + 信号评分
    UsableState getUsableState() { ... } // 获取可用性状态
}
```

**UsableState 枚举**（优先级从高到低）：

| UsableState | 分值 | 含义 |
|-------------|------|------|
| `HOME` | 2 | 在归属网络，最优 |
| `ROAMING_ENABLED` | 1 | 漫游但漫游数据已启用 |
| `NON_TERRESTRIAL` | 0 | 非地面网络（卫星） |
| `NOT_USABLE` | -1 | 不可用（无服务 / 漫游未启用） |

### AutoDataSwitchControllerCallback 接口

AutoDataSwitchController 通过此回调与 PhoneSwitcher 交互：

```java
interface AutoDataSwitchControllerCallback {
    void onRequireValidation(int targetPhoneId, boolean needValidation);
    void onRequireImmediatelySwitchToPhone(int targetPhoneId, int reason);
    void onRequireCancelAnyPendingAutoSwitchValidation();
}
```

| 回调方法 | 触发时机 |
|---------|---------|
| `onRequireValidation` | 稳定性检查通过，要求对目标 Phone 进行 Ping 验证 |
| `onRequireImmediatelySwitchToPhone` | 验证通过（或无需验证），要求立即切换到目标 Phone |
| `onRequireCancelAnyPendingAutoSwitchValidation` | 取消所有待处理的自动切换验证 |

### StabilityEventExtra / EvaluateEventExtra

```java
private record StabilityEventExtra(int targetPhoneId, int switchType, boolean needValidation) {}
private record EvaluateEventExtra(int evaluateReason) {}
```

## 3 评分机制

评分机制是自动切换的核心决策依据，回答"凭什么判断该切换"。

### RatSignalScore

`RatSignalScore` 由 `DataConfigManager` 计算，综合了 RAT（无线接入技术）类型和信号强度：

- LTE/5G NR 等高代 RAT 的基础分高于 3G/2G
- 同一 RAT 下，信号越强分数越高
- 具体计算逻辑封装在 `DataConfigManager.getRatSignalScore()` 中

### comparePhones 比较规则

`comparePhones(candidateId, baselineId)` 是评分对比的核心方法，按以下顺序决策：

```
1. 比较 UsableState 分数
   - candidate.UsableState > baseline.UsableState → candidate 胜出
   - candidate.UsableState < baseline.UsableState → baseline 胜出
   - 相等 → 进入第 2 步

2. 计算 RatSignalScore 差值
   - scoreDiff = candidate.RatSignalScore - baseline.RatSignalScore

3. 与 ScoreTolerance 比较
   - scoreDiff > mScoreTolerance → candidate 胜出（显著更优）
   - scoreDiff ≤ mScoreTolerance → 不切换（差异在容差范围内）

4. 特殊情况
   - mScoreTolerance ≤ 0 → 禁用基于 RAT/信号的切换，仅依赖 UsableState
```

### ScoreTolerance 的含义

| ScoreTolerance 值 | 效果 |
|------------------|------|
| `≤ 0` | 禁用基于 RAT/信号的 PERFORMANCE_SWITCH，仅 UsableState 变化才触发切换 |
| `> 0` | 只有 RatSignalScore 差值超过此阈值才触发切换，避免微小信号波动导致频繁切换 |

### getBetterCandidatePhoneIdBasedOnScore

用于备卡模式下的快速判断：遍历所有候选 Phone，返回第一个 RatSignalScore 优于当前 Phone 的候选（不涉及 UsableState 比较）。这是 `evaluateSwitchOutOfTarget` 中的快速路径。

## 4 评估入口与调度

### evaluateAutoDataSwitch — 公开入口

所有外部触发都通过此方法进入：

```java
public void evaluateAutoDataSwitch(int reason) {
    // 1. 刷新 CarrierConfig（运营商配置可能已变化）
    readCarrierConfigIfNeeded();
    // 2. 发送 Handler 异步消息，避免在回调栈中直接评估
    obtainMessage(EVENT_EVALUATE_AUTO_DATA_SWITCH,
            new EvaluateEventExtra(reason)).sendToTarget();
}
```

### 9 种触发原因详解

| 触发原因 | 触发场景 | 对应事件源 |
|---------|---------|-----------|
| `REGISTRATION_STATE_CHANGED` | PS 域注册状态变化（有服务 ↔ 无服务） | PhoneSignalStatus 数据更新 |
| `DISPLAY_INFO_CHANGED` | TelephonyDisplayInfo 变化（如进入 5G NSA/mmWave） | PhoneSwitcher 回调 |
| `SIGNAL_STRENGTH_CHANGED` | 信号等级变化（如从 4 格变 2 格） | PhoneSignalStatus 数据更新 |
| `DEFAULT_NETWORK_CHANGED` | 默认网络能力变化（如 Wi-Fi 断开）或丢失 | ConnectivityManager 回调 |
| `DATA_SETTINGS_CHANGED` | 用户开关数据业务 | DataSettingsManager 回调 |
| `RETRY_VALIDATION` | Ping 验证失败后延迟重试 | 内部 Handler 调度 |
| `SIM_LOADED` | SIM 卡加载完成（初始化信号追踪） | UiccProfile 回调 |
| `VOICE_CALL_END` | 语音通话结束（通话期间可能信号变化） | Phone 回调 |
| `CARRIER_CONFIG_CHANGED` | 运营商配置变化（ScoreTolerance 等） | CarrierConfigManager 回调 |

### onEvaluateAutoDataSwitch — 核心调度

Handler 收到消息后执行的核心评估逻辑：

```
onEvaluateAutoDataSwitch(reason):
  │
  ├→ 前置检查
  │    ├→ numActiveModems < 2？→ 直接返回（需要双卡）
  │    └→ isAutoDataSwitchEnabled() == false？→ 直接返回
  │
  ├→ 获取当前状态
  │    currentDataPhoneId = mPhoneSwitcher.getPreferredDataPhoneId()
  │
  ├→ 方向判断
  │    ├→ currentDataPhoneId == mSelectedTargetPhoneId (stickyTarget)
  │    │    └→ evaluateSwitchOutOfTarget(stickyTarget)
  │    │         // 已在备卡上，评估是否切到更好的或回退
  │    │
  │    └→ currentDataPhoneId != mSelectedTargetPhoneId
  │         └→ evaluateSwitchToTarget(targetPhoneId, currentDataPhoneId)
  │              // 在默认卡上，评估是否切到备卡
```

## 5 离开目标评估

当当前数据 Phone 就是 stickyTarget（即已经在自动切换的目标备卡上）时，系统评估是否应该切走。

### evaluateSwitchOutOfTarget 逻辑

```
evaluateSwitchOutOfTarget(stickyTargetPhoneId):
  │
  ├→ 遍历所有候选 Phone（排除当前 Phone）
  │    │
  │    ├→ 对每个候选调用 comparePhones(candidateId, stickyTargetPhoneId)
  │    │
  │    ├→ 找到优于当前 stickyTarget 的候选？
  │    │    │
  │    │    ├→ 是 → startStabilityCheck(candidateId, switchType, needValidation)
  │    │    │        // switchType 取决于候选优于 stickyTarget 的原因
  │    │    │
  │    │    └→ 否 → 继续遍历
  │    │
  │    └→ 遍历结束，未找到更优候选
  │         └→ cancelAnyPendingSwitch()
  │              // 无更优选择，保持当前（自动回退：什么都不做）
```

### getBetterCandidatePhoneIdBasedOnScore

此方法是 `evaluateSwitchOutOfTarget` 中的优化路径：仅比较 RatSignalScore（不涉及 UsableState），快速找到第一个分数更优的候选 Phone。适用于两张卡 UsableState 相同的场景。

## 6 切换到目标评估

当当前数据 Phone 不是 stickyTarget（即在用户设定的默认 DDS 卡上）时，系统评估是否应该切到目标备卡。

### evaluateSwitchToTarget 逻辑

```
evaluateSwitchToTarget(targetPhoneId, currentDataPhoneId):
  │
  ├→ comparePhones(targetPhoneId, currentDataPhoneId)
  │    │
  │    ├→ target 优于 current？
  │    │    ├→ 是 → startStabilityCheck(targetPhoneId, switchType, needValidation)
  │    │    │
  │    │    └→ 否 → cancelAnyPendingSwitch()
  │    │              // 目标不优于当前，保持 DDS
  │    │
  │    └→ target == current？→ 无需切换
```

### stickyTarget 裁剪机制

`mSelectedTargetPhoneId`（stickyTarget）的作用是**裁剪频繁评估范围**：

- 一旦自动切换到某个目标 Phone，该 PhoneId 被记录为 stickyTarget
- 后续评估只在"是否要离开 stickyTarget"和"是否要切到 stickyTarget"之间二选一
- 避免在多个 Phone 之间来回震荡（ping-pong 效应）

## 7 稳定性检查

自动切换不会在评分通过后立即执行，而是先经过稳定性检查定时器。这确保信号变化是持续的而非瞬时的波动。

### 三种稳定性检查类型

| 类型 | 常量值 | 触发条件 | 典型超时 |
|------|--------|---------|---------|
| `STABILITY_CHECK_AVAILABILITY_SWITCH` | 0 | 一张 SIM 有服务，另一张无服务 | 较短（几秒） |
| `STABILITY_CHECK_PERFORMANCE_SWITCH` | 1 | 一张 SIM 的 RAT/信号评分显著高于另一张 | 较长（30s+） |
| `STABILITY_CHECK_AVAILABILITY_SWITCH_BACK` | 2 | 两张 SIM 都无服务，切回默认 DDS | 较短（几秒） |

### startStabilityCheck 逻辑

```java
private void startStabilityCheck(int targetPhoneId, int switchType, boolean needValidation) {
    long timeout = getStabilityCheckTimeoutMs(switchType);

    if (timeout < 30_000) {
        // 短超时：使用 Handler.postDelayed（进程存活期间可靠）
        sendEmptyMessageDelayed(EVENT_STABILITY_CHECK_TIMEOUT, timeout);
    } else {
        // 长超时：使用 AlarmManager（即使进程休眠也能唤醒）
        AlarmManager am = mContext.getSystemService(AlarmManager.class);
        PendingIntent pi = PendingIntent.getBroadcast(...);
        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + timeout, pi);
    }
}
```

**定时器选择策略**：

| 条件 | 定时器方式 | 原因 |
|------|-----------|------|
| 超时 < 30s | `Handler.postDelayed` | 进程不会在 30s 内休眠，Handler 足够可靠 |
| 超时 >= 30s | `AlarmManager` | 进程可能休眠，需要系统级唤醒机制保证定时精度 |

### 超时配置来源

稳定性检查超时值由 CarrierConfig 或 DeviceConfig 提供：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `auto_data_switch_availability_stability_timeout_ms` | 几秒 | AVAILABILITY_SWITCH 超时 |
| `auto_data_switch_performance_stability_timeout_ms` | 30s+ | PERFORMANCE_SWITCH 超时 |
| `auto_data_switch_availability_switch_back_timeout_ms` | 几秒 | SWITCH_BACK 超时 |

### 定时器到期处理

```
EVENT_STABILITY_CHECK_TIMEOUT:
  │
  ├→ 重新检查 comparePhones（信号可能在等待期间又变了）
  │    │
  │    ├→ 仍然满足切换条件？
  │    │    ├→ 是 → mRequirePingTestBeforeSwitch?
  │    │    │    ├→ 是 → callback.onRequireValidation(targetPhoneId, true)
  │    │    │    └→ 否 → callback.onRequireImmediatelySwitchToPhone(targetPhoneId, reason)
  │    │    │
  │    │    └→ 否 → 取消切换（信号已恢复，无需切换）
```

## 8 Ping 验证与重试

稳定性检查通过后，如果配置了 Ping 验证，系统会在实际切换前验证目标网络是否可用。

### mRequirePingTestBeforeSwitch 开关

由 CarrierConfig 或 DeviceConfig 控制：

| 值 | 效果 |
|----|------|
| `true` | 稳定性检查通过后，还需 Ping 验证目标网络连通性 |
| `false` | 跳过 Ping 验证，稳定性检查通过即可切换 |

### 验证流程

```
稳定性检查通过
  │
  ▼
callback.onRequireValidation(targetPhoneId, needValidation = true)
  │
  ▼  (PhoneSwitcher 收到回调)
PhoneSwitcher 要求 ConnectivityManager 对目标 Phone 执行 Ping 测试
  │
  ├→ Ping 成功 → callback.onRequireImmediatelySwitchToPhone(targetPhoneId, reason)
  │    └→ 执行实际切换
  │
  └→ Ping 失败 → evaluateRetryOnValidationFailed()
       └→ 指数退避重试
```

### 指数退避重试机制

```java
private void evaluateRetryOnValidationFailed() {
    mAutoSwitchValidationFailedCount++;

    if (mAutoSwitchValidationFailedCount > mAutoDataSwitchValidationMaxRetry) {
        // 超过最大重试次数，放弃本次自动切换
        mAutoSwitchValidationFailedCount = 0;
        return;
    }

    // 指数退避：每次等待时间翻倍
    long delayMs = (long) Math.pow(2, mAutoSwitchValidationFailedCount) * BASE_RETRY_DELAY_MS;

    // 延迟后以 RETRY_VALIDATION 原因重新评估
    sendEmptyMessageDelayed(EVENT_EVALUATE_AUTO_DATA_SWITCH, delayMs);
}
```

| 关键参数 | 说明 |
|---------|------|
| `mAutoSwitchValidationFailedCount` | 连续失败计数，每次失败 +1 |
| `mAutoDataSwitchValidationMaxRetry` | 最大重试次数，超过后重置计数器并放弃 |
| 退避策略 | 指数退避：2^n * BASE_RETRY_DELAY_MS |

验证成功或超过最大重试次数后，`mAutoSwitchValidationFailedCount` 重置为 0。

## 9 自动回退机制

自动切换是"临时行为"，不改变用户设定的 DDS。当条件不再满足时，系统会自动回到用户设定的默认数据卡。

### 回退触发条件

| 条件 | 行为 |
|------|------|
| 目标 Phone 信号恶化，评分差 ≤ ScoreTolerance | `evaluateSwitchOutOfTarget` 遍历候选后未找到更优，`cancelAnyPendingSwitch()` |
| 目标 Phone 完全失去服务 | 触发 AVAILABILITY_SWITCH_BACK 或切回 DDS |
| 默认网络恢复（如 Wi-Fi 断开后回到蜂窝） | `onDefaultNetworkCapabilitiesChanged` 触发重新评估 |

### cancelAnyPendingSwitch 的作用

```java
private void cancelAnyPendingSwitch() {
    // 1. 取消所有待处理的稳定性检查定时器
    removeMessages(EVENT_STABILITY_CHECK_TIMEOUT);
    cancelStabilityCheckAlarm();

    // 2. 取消所有待处理的 Ping 验证
    mPhoneSwitcherCallback.onRequireCancelAnyPendingAutoSwitchValidation();

    // 3. 如果当前不在 DDS 上，尝试切回 DDS
    if (mPhoneSwitcher.getPreferredDataPhoneId() != ddsPhoneId) {
        mPhoneSwitcherCallback.onRequireImmediatelySwitchToPhone(
            ddsPhoneId, DATA_SWITCH_REASON_AUTO_SWITCH_INVALIDATED);
    }
}
```

### 与手动切换的根本区别

手动切换改变的是系统持久化的 DDS（`mPrimaryDataSubId`），是确定性的、永久的（直到用户再次切换）。

自动切换的回退本质上就是"不做什么"——取消待处理的切换，让系统回到用户设定的 DDS。如果当前已经在备卡上，则主动发起回退切换。回退不改变 DDS 设置本身。

## 10 事件监听管理

AutoDataSwitchController 通过监听三类事件来感知信号变化，动态注册/注销策略减少不必要的追踪。

### updateListenerRegistrations 动态策略

```java
private void updateListenerRegistrations() {
    for (int i = 0; i < mPhonesSignalStatus.length; i++) {
        boolean shouldListen = shouldListenForPhone(i);

        if (shouldListen && !mPhonesSignalStatus[i].mListeningForEvents) {
            registerAllEventsForPhone(i);
        } else if (!shouldListen && mPhonesSignalStatus[i].mListeningForEvents) {
            unregisterAllEventsForPhone(i);
        }
    }
}
```

### registerAllEventsForPhone — 三类事件注册

```java
private void registerAllEventsForPhone(int phoneId) {
    Phone phone = PhoneFactory.getPhone(phoneId);

    // 1. ServiceState — PS 域注册状态
    phone.registerForServiceStateTrackerChanged(
        this, EVENT_REGISTRATION_STATE_CHANGED, phoneId);

    // 2. TelephonyDisplayInfo — 网络类型 / 5G 状态
    phone.registerForTelephonyDisplayInfoChanged(
        this, EVENT_DISPLAY_INFO_CHANGED, phoneId);

    // 3. SignalStrength — 信号强度
    phone.registerForSignalStrengthChanged(
        this, EVENT_SIGNAL_STRENGTH_CHANGED, phoneId);

    mPhonesSignalStatus[phoneId].mListeningForEvents = true;
}
```

| 事件 | 对应变化 | 触发原因 |
|------|---------|---------|
| ServiceState | PS 域注册状态变化 | `REGISTRATION_STATE_CHANGED` |
| TelephonyDisplayInfo | 网络显示信息变化（含 5G NSA/mmWave） | `DISPLAY_INFO_CHANGED` |
| SignalStrength | 信号强度等级变化 | `SIGNAL_STRENGTH_CHANGED` |

### onMultiSimConfigChanged — SIM 配置变化

当设备在单卡/双卡之间切换时：

```java
public void onMultiSimConfigChanged(int numActiveModems) {
    // 1. 调整 mPhonesSignalStatus 数组大小
    mPhonesSignalStatus = new PhoneSignalStatus[numActiveModems];

    // 2. 重新注册事件监听
    updateListenerRegistrations();

    // 3. 单卡模式下无需自动切换
    if (numActiveModems < 2) {
        cancelAnyPendingSwitch();
    }
}
```

### 注销时机

- SIM 卡拔出 / 设备切到单卡模式
- 自动数据切换功能被禁用
- `mPhonesSignalStatus` 对应 Phone 不再是活跃 modem

## 11 配置体系

自动切换的各项参数由两层配置提供，CarrierConfig 优先于 DeviceConfig。

### 配置优先级

```
CarrierConfig（运营商级别）
  │  优先级更高，覆盖设备默认值
  ▼
DeviceConfig（设备级别）
  │  默认值，所有运营商共享
  ▼
readDeviceResourceConfig()  →  readCarrierConfigIfNeeded()
```

### DeviceConfig 默认值

| 配置项 | 说明 |
|--------|------|
| `mScoreTolerance` | 评分容差阈值，≤0 禁用 RAT/信号切换 |
| `mRequirePingTestBeforeSwitch` | 是否需要 Ping 验证 |
| `mAutoDataSwitchValidationMaxRetry` | 最大验证重试次数 |
| AVAILABILITY_SWITCH 超时 | 无服务→有服务切换的稳定性超时 |
| PERFORMANCE_SWITCH 超时 | RAT/信号优化的稳定性超时 |
| SWITCH_BACK 超时 | 双卡无服务回退的稳定性超时 |

### CarrierConfig 关键配置项

| 配置项 | 作用 |
|--------|------|
| `KEY_AUTO_DATA_SWITCH_AVAILABILITY_STABILITY_TIMEOUT_MS` | AVAILABILITY_SWITCH 超时 |
| `KEY_AUTO_DATA_SWITCH_PERFORMANCE_STABILITY_TIMEOUT_MS` | PERFORMANCE_SWITCH 超时 |
| `KEY_AUTO_DATA_SWITCH_PERFORMANCE_SWITCH_BACK_TIMEOUT_MS` | SWITCH_BACK 超时 |
| `KEY_AUTO_DATA_SWITCH_SCORE_TOLERANCE_INT` | 评分容差 |
| `KEY_AUTO_DATA_SWITCH_PING_TEST_BEFORE_SWITCH_BOOL` | Ping 验证开关 |

### OPPT 机会性网络支持

```java
private boolean shouldExcludeOpportunisticForSwitch() {
    // 通过 CarrierConfig 判断是否排除机会性网络的切换
    // 机会性网络：CBRS（公民宽带无线电服务）等共享频谱
    return mCarrierConfig.getBoolean(
        CarrierConfigManager.KEY_AUTO_DATA_SWITCH_EXCLUDE_OPPORTUNISTIC_BOOL);
}
```

### 配置读取流程

```
evaluateAutoDataSwitch(reason)
  │
  └→ readCarrierConfigIfNeeded()
       │
       ├→ mCarrierConfigManager.getCarrierConfig(subId)
       │    └→ 提取 CarrierConfig 覆盖值
       │
       └→ 未配置的参数 → 使用 readDeviceResourceConfig() 的默认值
```

## 12 通知机制

自动切换是系统行为，用户可能不知情。系统通过 Notification 告知用户。

### displayAutoDataSwitchNotification

```java
private void displayAutoDataSwitchNotification(int phoneId, boolean isDueToAutoSwitch) {
    if (mDisplayedNotification) return; // 只显示一次

    mDisplayedNotification = true;

    // 构建通知：告知用户数据已自动切换到另一张 SIM
    Notification notification = new Notification.Builder(mContext, CHANNEL_ID)
        .setContentTitle("数据已自动切换")
        .setContentText("数据连接已切换到 SIM " + (phoneId + 1))
        .setSmallIcon(R.drawable.ic_sim)
        .setContentIntent(getNotificationIntent())  // 点击打开设置
        .build();

    mNotificationManager.notify(NOTIFICATION_ID, notification);
}
```

### mDisplayedNotification 首次标记

- 只在**首次**自动切换成功时显示通知
- 后续自动切换不再重复通知（避免打扰）
- 用户关闭通知或设备重启后标记重置

### 与手动切换的 UX 差异

| 维度 | 手动切换 | 自动切换 |
|------|---------|---------|
| 用户感知 | 用户主动操作，完全知情 | 系统后台切换，通过 Notification 告知 |
| 通知 | 无需通知 | 首次切换显示通知 |
| 用户操作 | 可点击通知进入设置，将当前 SIM 设为默认 DDS | — |

## 13 完整调用链汇总

### 自动切换全流程时序

```
[信号变化] → PhoneSignalStatus 更新
     │
     ▼
AutoDataSwitchController.evaluateAutoDataSwitch(REGISTRATION_STATE_CHANGED)
     │
     ├→ readCarrierConfigIfNeeded()
     │
     └→ onEvaluateAutoDataSwitch()
          │
          ├→ comparePhones(target, current)
          │    └→ target 优于 current ✅
          │
          └→ startStabilityCheck(target, PERFORMANCE_SWITCH)
               │
               ▼  [等待超时，如 30s]
          Handler / AlarmManager 触发
               │
               ├→ comparePhones 再次验证 ✅
               │
               ├→ mRequirePingTestBeforeSwitch?
               │    │
               │    ├→ 是 → onRequireValidation(target)
               │    │         │
               │    │         ▼  [ConnectivityManager Ping]
               │    │    ├→ 成功 → onRequireImmediatelySwitchToPhone(target)
               │    │    └→ 失败 → evaluateRetryOnValidationFailed()
               │    │              └→ [指数退避] → 重新评估
               │    │
               │    └→ 否 → onRequireImmediatelySwitchToPhone(target)
               │                │
               │                ▼
               │         PhoneSwitcher 执行切换
               │                │
               │                ├→ setDataAllowed / setPreferredDataModem
               │                └→ DataNetworkController 建立数据网络
               │
               └→ displayAutoDataSwitchNotification(target)  [首次]
```

### 与手动 DDS 切换对比

| 维度 | 手动切换 | 自动切换 |
|------|---------|---------|
| 入口 | `SubscriptionManagerService.setDefaultDataSubId()` | `AutoDataSwitchController.evaluateAutoDataSwitch()` |
| 决策 | 用户主观选择 | `comparePhones()` 评分对比 |
| 检查 | 无 | 稳定性检查 + 可选 Ping 验证 |
| 执行 | PhoneSwitcher.onDefaultDataSubscriptionChanged() | PhoneSwitcher 回调（DATA_SWITCH_REASON_AUTO） |
| HAL 命令 | 相同（setDataAllowed / setPreferredDataModem） | 相同 |
| DDS 变化 | 改变 `mPrimaryDataSubId` | 不改变，使用 `mAutoSelectedDataSubId` |
| 回退 | 无 | 条件不满足时自动回到 DDS |

### 与紧急 DDS 覆盖的边界

紧急 DDS 覆盖（`overrideDefaultDataForEmergency`）用于 GNSS SUPL 等紧急场景，优先级高于自动切换：

- 紧急覆盖生效期间，自动切换被暂停
- 紧急覆盖结束后，通过 `VOICE_CALL_END` 或其他原因重新触发评估
- 紧急覆盖直接修改 DDS，与自动切换的"不改变 DDS"策略不同

