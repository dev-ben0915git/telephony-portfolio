---
title: "Android 双卡数据卡切换与数据激活/去激活全流程分析"
date: "2025-06-28"
summary: "从用户切换默认数据卡到数据连接完全迁移的完整流程分析，涵盖 DDS 切换决策、PhoneSwitcher 双 HAL 命令模式（ALLOW_DATA / PREFERRED_DATA）、旧卡数据去激活、新卡数据激活与网络重建。"
category: "data-service"
tags: ["SubscriptionManagerService", "PhoneSwitcher", "DataNetworkController", "DDS", "ALLOW_DATA", "PREFERRED_DATA", "setDataAllowed", "setPreferredDataModem", "TelephonyRegistry", "RIL_REQUEST_ALLOW_DATA"]
featured: true
---

## 1 概述

在 Android 双卡双待（DSDS）设备中，数据连接只能绑定到一张 SIM 卡。当用户切换默认数据订阅（Default Data Subscription, DDS）时，系统需要完成一系列操作：关闭旧卡的数据、通知 modem 切换数据通道、在新卡上重新建立数据连接。

Android Telephony 框架通过三个核心组件协同完成 DDS 切换：

- **SubscriptionManagerService**：DDS 切换的入口，设置默认数据订阅 ID 并广播通知
- **PhoneSwitcher**：数据电话切换调度中心，根据 HAL 版本选择不同命令通知 modem
- **DataNetworkController**：数据网络控制器，负责拆除旧卡数据网络、在新卡上建立数据网络

modem 层面支持两种数据切换命令模式：

| HAL 命令模式 | 版本 | RIL 请求 | 特点 |
|-------------|------|----------|------|
| `HAL_COMMAND_ALLOW_DATA` | IRadio 1.0 | `RIL_REQUEST_ALLOW_DATA` / `setDataAllowed` | 通过 allow/deactivate 控制每个 modem 的 PS 附着 |
| `HAL_COMMAND_PREFERRED_DATA` | IRadioConfig 1.1+ | `setPreferredDataModem` | 直接指定哪个 modem 为首选数据 modem，所有 modem 都允许 PS 附着 |

### 整体架构

```
用户操作 (Settings / TelephonyManager API)
  │
  ▼
SubscriptionManagerService.setDefaultDataSubId(subId)
  │
  ├→ MultiSimSettingController.notifyDefaultDataSubChanged()
  │    └→ disableDataForNonDefaultNonOpportunisticSubscriptions()
  │       └→ DataSettingsManager.setDataEnabled(USER, false)   // 关闭旧卡数据
  │
  ├→ broadcastSubId(ACTION_DEFAULT_DATA_SUBSCRIPTION_CHANGED)
  │
  └→ callback.onDefaultDataSubscriptionChanged(subId)
       │
       ├→ PhoneSwitcher.evaluateIfImmediateDataSwitchIsNeeded()
       │    └→ onEvaluate()
       │       ├→ updatePreferredDataPhoneId()
       │       ├→ activate(newPhoneId) / deactivate(oldPhoneId)
       │       └→ sendRilCommands()
       │          ├→ setDataAllowed(true/false)   [HAL_COMMAND_ALLOW_DATA]
       │          └→ setPreferredDataModem(phoneId) [HAL_COMMAND_PREFERRED_DATA]
       │
       └→ DataSettingsManager.updateDataEnabledAndNotify(OVERRIDE)
            └→ DataNetworkController.onDataEnabledChanged()
               ├→ EVENT_REEVALUATE_EXISTING_DATA_NETWORKS  // 拆除旧卡数据
               └→ EVENT_REEVALUATE_UNSATISFIED_NETWORK_REQUESTS  // 建立新卡数据
```

## 2 核心类一览

| 类名 | 职责 | 源码路径 |
|------|------|----------|
| **SubscriptionManagerService** | 订阅管理服务，DDS 切换入口，设置默认数据订阅 ID 并广播 | `telephony/.../subscription/SubscriptionManagerService.java` |
| **MultiSimSettingController** | 多 SIM 设置协调器，DDS 切换时关闭非默认卡数据，同步组内设置 | `telephony/.../MultiSimSettingController.java` |
| **PhoneSwitcher** | 数据电话切换调度中心，根据 HAL 版本选择命令模式通知 modem | `telephony/.../data/PhoneSwitcher.java` |
| **AutoDataSwitchController** | 自动数据切换控制器，基于信号/可用性评估是否自动切换 DDS | `telephony/.../data/AutoDataSwitchController.java` |
| **DataSettingsManager** | 每卡数据设置管理，DDS 变化时重新评估数据启用策略 | `telephony/.../data/DataSettingsManager.java` |
| **DataNetworkController** | 数据网络控制器，负责数据网络的拆除和建立 | `telephony/.../data/DataNetworkController.java` |
| **DataNetwork** | 单个 PDN 状态机，管理连接建立和拆除的完整生命周期 | `telephony/.../data/DataNetwork.java` |
| **RadioConfig** | Radio 配置接口，支持 `setPreferredDataModem` 命令 | `telephony/.../RadioConfig.java` |
| **RIL** | Radio Interface Layer，支持 `setDataAllowed` 命令 | `telephony/.../RIL.java` |

> 源码路径前缀均为 `d:\code\aosp\telephony\src\java\com\android\internal\telephony\`

## 3 DDS 切换入口流程

### 3.1 SubscriptionManagerService.setDefaultDataSubId

用户在设置界面切换默认数据卡，或应用通过 `TelephonyManager.setDefaultDataSubId()` 发起请求，最终调用 `SubscriptionManagerService.setDefaultDataSubId(subId)`。

```java
// SubscriptionManagerService.java
public void setDefaultDataSubId(int subId) {
    if (mDefaultDataSubId.set(subId)) {    // 原子操作，仅在真正变化时返回 true
        remapRafIfApplicable();              // 重新映射 Radio Access Family
        MultiSimSettingController.getInstance().notifyDefaultDataSubChanged();
        broadcastSubId(ACTION_DEFAULT_DATA_SUBSCRIPTION_CHANGED, subId);
        mSubscriptionManagerServiceCallbacks.forEach(
            callback -> callback.invokeFromExecutor(
                () -> callback.onDefaultDataSubscriptionChanged(subId)));
        updateDefaultSubId();
    }
}
```

`mDefaultDataSubId.set(subId)` 使用原子操作，仅当 subId 真正发生变化时才执行后续逻辑。变化后的操作分为三路并行通知：

1. `remapRafIfApplicable()` — 将最大 RAF 分配给 DDS 所在的 slot，其余 slot 分配最小 RAF
2. `MultiSimSettingController.notifyDefaultDataSubChanged()` — 通知多 SIM 设置控制器
3. 广播 + 回调 — 通知 `PhoneSwitcher`、`DataSettingsManager` 等监听者

### 3.2 remapRafIfApplicable — Radio Access Family 重映射

DDS 所在的 slot 获得最大 RAF（支持所有无线接入技术），非 DDS 的 slot 获得最小 RAF。通过 `ProxyController.setRadioCapability()` 发送 `RIL_REQUEST_SET_RADIO_CAPABILITY` 请求，modem 会据此调整各 slot 支持的 RAT。

### 3.3 广播 ACTION_DEFAULT_DATA_SUBSCRIPTION_CHANGED

`broadcastSubId` 方法通过 `Intent` 广播 `TelephonyManager.ACTION_DEFAULT_DATA_SUBSCRIPTION_CHANGED`，携带新的 subId。Settings UI 和其他应用通过监听此广播来更新界面。

## 4 MultiSimSettingController 协调处理

### 4.1 notifyDefaultDataSubChanged → onDefaultDataSettingChanged

`MultiSimSettingController` 收到通知后，发送 `EVENT_DEFAULT_DATA_SUBSCRIPTION_CHANGED` Handler 消息，处理逻辑调用 `onDefaultDataSettingChanged`：

```java
// MultiSimSettingController.java
private void onDefaultDataSettingChanged() {
    disableDataForNonDefaultNonOpportunisticSubscriptions();
}
```

### 4.2 disableDataForNonDefaultNonOpportunisticSubscriptions

该方法遍历所有 Phone 实例，将**非默认数据订阅、非 opportunistic、且与默认订阅不在同一组**的 Phone 的用户数据关闭：

```java
// MultiSimSettingController.java
protected void disableDataForNonDefaultNonOpportunisticSubscriptions() {
    int defaultDataSub = mSubscriptionManagerService.getDefaultDataSubId();
    for (Phone phone : PhoneFactory.getPhones()) {
        SubscriptionInfoInternal subInfo = mSubscriptionManagerService
                .getSubscriptionInfoInternal(phone.getSubId());
        boolean isOpportunistic = subInfo != null && subInfo.isOpportunistic();
        if (phone.getSubId() != defaultDataSub
                && SubscriptionManager.isValidSubscriptionId(phone.getSubId())
                && !isOpportunistic
                && phone.isUserDataEnabled()
                && !areSubscriptionsInSameGroup(defaultDataSub, phone.getSubId())) {
            phone.getDataSettingsManager().setDataEnabled(
                    TelephonyManager.DATA_ENABLED_REASON_USER, false,
                    mContext.getOpPackageName());
        }
    }
}
```

关闭条件：
- `phone.getSubId() != defaultDataSub` — 不是新的默认数据订阅
- `SubscriptionManager.isValidSubscriptionId(phone.getSubId())` — 订阅有效
- `!isOpportunistic` — 不是 opportunistic（辅助）订阅
- `phone.isUserDataEnabled()` — 当前数据已开启
- `!areSubscriptionsInSameGroup(...)` — 不与默认订阅在同一组

### 4.3 DataSettingsManager 收到 setDataEnabled(false) 的后续

旧卡收到 `setDataEnabled(DATA_ENABLED_REASON_USER, false)` 后，按照数据关闭流程（参见《数据开关与数据激活去激活技术文档》第 4 章）：

```
DataSettingsManager.setDataEnabled(USER, false)
  → updateDataEnabledAndNotify(USER)
    → notifyDataEnabledChanged(false)
      → DataNetworkController.onDataEnabledChanged(false)
        → EVENT_REEVALUATE_EXISTING_DATA_NETWORKS
          → evaluateDataNetwork → DATA_DISABLED
            → tearDownGracefully → DataNetwork.tearDown
              → DataServiceManager.deactivateDataCall
                → CellularDataService → RIL → RadioDataProxy → Modem
```

旧卡的数据网络被拆除，modem 释放旧卡上的数据连接资源。

## 5 PhoneSwitcher 调度切换

### 5.1 收到 DDS 变化回调

`PhoneSwitcher` 在构造函数中通过 `SubscriptionManagerService.registerCallback` 注册了回调：

```java
// PhoneSwitcher.java 构造函数中
mSubscriptionManagerService.registerCallback(new SubscriptionManagerServiceCallback(this::post) {
    @Override
    public void onDefaultDataSubscriptionChanged(int subId) {
        evaluateIfImmediateDataSwitchIsNeeded("default data sub changed to " + subId,
                DataSwitch.Reason.DATA_SWITCH_REASON_MANUAL);
    }
});
```

`DataSwitch.Reason.DATA_SWITCH_REASON_MANUAL` 标记这是一次用户手动切换。

### 5.2 evaluateIfImmediateDataSwitchIsNeeded

```java
// PhoneSwitcher.java
private void evaluateIfImmediateDataSwitchIsNeeded(String evaluationReason, int switchReason) {
    if (onEvaluate(REQUESTS_UNCHANGED, evaluationReason)) {
        logDataSwitchEvent(mPreferredDataSubId.get(),
                TelephonyEvent.EventState.EVENT_STATE_START, switchReason);
        registerDefaultNetworkChangeCallback(mPreferredDataSubId.get(), switchReason);
    }
}
```

调用 `onEvaluate` 进行评估，如果检测到变化则记录切换事件并注册默认网络变化回调。

### 5.3 onEvaluate — 核心评估逻辑

`onEvaluate` 是 `PhoneSwitcher` 最核心的方法，负责决定哪些 Phone 需要激活、哪些需要去激活：

```java
// PhoneSwitcher.java
protected boolean onEvaluate(boolean requestsChanged, String reason) {
    // 1. 检查默认数据订阅是否变化
    int primaryDataSubId = mSubscriptionManagerService.getDefaultDataSubId();
    if (primaryDataSubId != mPrimaryDataSubId) {
        mPrimaryDataSubId = primaryDataSubId;
        mLastSwitchPreferredDataReason = DataSwitch.Reason.DATA_SWITCH_REASON_MANUAL;
    }

    // 2. 检查 phoneId-to-subId 映射是否变化
    for (int i = 0; i < mActiveModemCount; i++) {
        int sub = SubscriptionManager.getSubscriptionId(i);
        if (sub != mPhoneSubscriptions[i]) {
            mPhoneSubscriptions[i] = sub;
            diffDetected = true;
        }
    }

    // 3. 更新首选数据 Phone ID
    updatePreferredDataPhoneId();

    // 4. 根据变化执行 activate/deactivate
    if (diffDetected || EVALUATION_REASON_RADIO_ON.equals(reason)) {
        // 两种 HAL 命令模式分支处理
    }
    return diffDetected;
}
```

### 5.4 updatePreferredDataPhoneId

决定哪个 Phone 应该处理默认数据请求：

```java
// PhoneSwitcher.java
protected void updatePreferredDataPhoneId() {
    if (mEmergencyOverride != null) {
        // 紧急覆盖 DDS
        mPreferredDataPhoneId = mEmergencyOverride.mPhoneId;
    } else if (isInEmergencyMode()) {
        // 紧急模式，跳过切换
        return;
    } else if (isAnyVoiceCallActiveOnDevice()) {
        // 有语音通话时，判断是否需要切换数据到通话所在 Phone
        mPreferredDataPhoneId = shouldSwitchDataDueToInCall()
                ? mPhoneIdInVoiceCall : getFallbackDataPhoneIdForInternetRequests();
    } else {
        // 默认回退到 autoSelected 或 primaryData 对应的 Phone
        mPreferredDataPhoneId = getFallbackDataPhoneIdForInternetRequests();
    }
    mPreferredDataSubId.set(SubscriptionManager.getSubscriptionId(mPreferredDataPhoneId));
}
```

`getFallbackDataPhoneIdForInternetRequests` 的优先级：
1. 如果 `mAutoSelectedDataSubId` 有效 → 使用其对应的 phoneId
2. 否则使用 `mPrimaryDataSubId`（用户设定的 DDS）对应的 phoneId

### 5.5 两种 HAL 命令模式的分支处理

#### HAL_COMMAND_PREFERRED_DATA 模式（IRadioConfig 1.1+）

所有 Phone 都标记为 active（允许 PS 附着），仅对首选数据 Phone 发送 `setPreferredDataModem`：

```java
// PhoneSwitcher.java onEvaluate
if (mHalCommandToUse == HAL_COMMAND_PREFERRED_DATA) {
    for (int phoneId = 0; phoneId < mActiveModemCount; phoneId++) {
        mPhoneStates[phoneId].active = true;    // 所有 Phone 都 active
    }
    sendRilCommands(mPreferredDataPhoneId);      // 仅发送 preferred data 命令
}
```

在这种模式下，modem 自己管理数据通道的切换，两个 modem 都可以 PS 附着，但只有 preferred modem 处理默认数据。

#### HAL_COMMAND_ALLOW_DATA 模式（IRadio 1.0）

需要明确 activate/deactivate 每个 Phone：

```java
// PhoneSwitcher.java onEvaluate
else {
    List<Integer> newActivePhones = new ArrayList<>();
    // 按优先级收集需要激活的 Phone：
    // 1. 如果所有 modem 都可同时 PS 附着（mMaxDataAttachModemCount == mActiveModemCount），全部激活
    // 2. 否则：
    //    a. 优先激活正在通话的 Phone
    //    b. 根据网络请求对应的 Phone
    //    c. 最后确保 mPreferredDataPhoneId 在激活列表中

    for (int phoneId = 0; phoneId < mActiveModemCount; phoneId++) {
        if (!newActivePhones.contains(phoneId)) {
            deactivate(phoneId);   // 去激活
        }
    }
    for (int phoneId : newActivePhones) {
        activate(phoneId);         // 激活
    }
}
```

### 5.6 activate / deactivate / switchPhone

```java
// PhoneSwitcher.java
protected void activate(int phoneId) {
    switchPhone(phoneId, true);
}
protected void deactivate(int phoneId) {
    switchPhone(phoneId, false);
}

private void switchPhone(int phoneId, boolean active) {
    PhoneState state = mPhoneStates[phoneId];
    if (state.active == active) return;       // 状态未变，跳过
    state.active = active;
    state.lastRequested = System.currentTimeMillis();
    sendRilCommands(phoneId);
}
```

### 5.7 sendRilCommands — 发送 RIL 命令

```java
// PhoneSwitcher.java
protected void sendRilCommands(int phoneId) {
    Message message = Message.obtain(this, EVENT_MODEM_COMMAND_DONE, phoneId);
    if (mHalCommandToUse == HAL_COMMAND_ALLOW_DATA
            || mHalCommandToUse == HAL_COMMAND_UNKNOWN) {
        if (mActiveModemCount > 1) {
            PhoneFactory.getPhone(phoneId).mCi.setDataAllowed(
                    isPhoneActive(phoneId), message);
        }
    } else if (phoneId == mPreferredDataPhoneId) {
        mRadioConfig.setPreferredDataModem(mPreferredDataPhoneId, message);
    }
}
```

## 6 RIL 层面数据切换

### 6.1 setDataAllowed（HAL_COMMAND_ALLOW_DATA 模式）

通过 `CommandsInterface.setDataAllowed(boolean allowed, Message result)` 发送 `RIL_REQUEST_ALLOW_DATA` 请求到 modem。

- `allowed = true` → 允许该 modem 进行 PS 附着，数据呼叫可以建立
- `allowed = false` → 禁止该 modem 的 PS 附着，已建立的数据连接会被释放

在 DDS 切换场景中：
- 旧 Phone：`setDataAllowed(false)` → modem 禁止 PS 附着
- 新 Phone：`setDataAllowed(true)` → modem 允许 PS 附着

### 6.2 setPreferredDataModem（HAL_COMMAND_PREFERRED_DATA 模式）

通过 `RadioConfig.setPreferredDataModem(int phoneId, Message result)` 发送 `RIL_REQUEST_SET_PREFERRED_DATA_MODEM` 请求到 modem。

modem 收到后，将指定 phoneId 的 modem 作为首选数据 modem，处理默认数据连接。两个 modem 都保持 PS 附着状态，但数据流量只通过 preferred modem。

### 6.3 两种模式对比

| 维度 | ALLOW_DATA | PREFERRED_DATA |
|------|-----------|----------------|
| RIL 请求 | `RIL_REQUEST_ALLOW_DATA` | `RIL_REQUEST_SET_PREFERRED_DATA_MODEM` |
| 调用接口 | `CommandsInterface.setDataAllowed` | `RadioConfig.setPreferredDataModem` |
| 控制粒度 | 每个 Phone 独立控制 allow/deactivate | 直接指定首选数据 Phone |
| 非 DDS modem | 禁止 PS 附着 | 允许 PS 附着（但非默认数据） |
| 切换时操作 | 旧卡 deactivate + 新卡 activate | 仅发送一次 preferred modem 命令 |
| 漫游卡数据 | 需要单独 allow 才能使用 | 由 modem 自行管理 |

## 7 DataSettingsManager 对 DDS 变化的响应

### 7.1 监听 DDS 变化

每个 Phone 实例的 `DataSettingsManager` 在初始化时注册了对 `SubscriptionManagerService` 的回调：

```java
// DataSettingsManager.java 构造函数中
SubscriptionManagerService.getInstance().registerCallback(
    new SubscriptionManagerService.SubscriptionManagerServiceCallback(this::post) {
        @Override
        public void onDefaultDataSubscriptionChanged(int subId) {
            log((subId == mSubId ? "Became" : "Not")
                    + " default data sub, reevaluating mobile data policies");
            DataSettingsManager.this.updateDataEnabledAndNotify(
                    TelephonyManager.DATA_ENABLED_REASON_OVERRIDE);
        }
    });
```

当 DDS 变化时，新卡和旧卡的 `DataSettingsManager` 都会收到回调。只有当 subId 匹配自身（"Became default data sub"）时，`updateDataEnabledAndNotify` 才有意义。

### 7.2 updateDataEnabledAndNotify

`DATA_ENABLED_REASON_OVERRIDE` 触发数据启用状态的重新评估。如果新卡的用户数据开关是开启的，且 policy、carrier、thermal 都允许，则 `mIsDataEnabled` 变为 true，通知 `DataNetworkController` 开始评估未满足的网络请求，建立数据网络。

## 8 DataNetworkController 数据去激活与重新激活

### 8.1 旧卡数据去激活

旧卡的 `DataNetworkController` 收到 `onDataEnabledChanged(false)` 后：

```
EVENT_REEVALUATE_EXISTING_DATA_NETWORKS
  → onReevaluateExistingDataNetworks(DATA_ENABLED_CHANGED)
    → evaluateDataNetwork(dataNetwork)
      → addDataDisallowedReason(DATA_DISABLED)
    → tearDownGracefully(dataNetwork, TEAR_DOWN_REASON_DATA_DISABLED)
      → DataNetwork.tearDown → DisconnectingState
        → DataServiceManager.deactivateDataCall
          → CellularDataService → RIL.deactivateDataCall
            → RadioDataProxy.deactivateDataCall → Modem
```

### 8.2 新卡数据重新激活

新卡的 `DataSettingsManager` 收到 DDS 变化后，调用 `updateDataEnabledAndNotify(OVERRIDE)`。如果新卡数据启用状态变为 true，其 `DataNetworkController` 收到 `onDataEnabledChanged(true)`：

```
EVENT_REEVALUATE_UNSATISFIED_NETWORK_REQUESTS
  → onReevaluateUnsatisfiedNetworkRequests(DATA_ENABLED_CHANGED)
    → evaluateDataNetworkRequest
    → setupDataNetwork(dataProfile, null, NORMAL)
      → new DataNetwork → ConnectingState
        → DataServiceManager.setupDataCall
          → CellularDataService → RIL.setupDataCall
            → RadioDataProxy.setupDataCall → Modem
```

### 8.3 PhoneSwitcher 回调通知 DataNetworkController

`PhoneSwitcher` 通过 `notifyPreferredDataSubIdChanged()` 通知 `TelephonyRegistryManager`，进而通知 `ConnectivityService`。`ConnectivityService` 收到活跃数据订阅变化后，会重新发送 `NetworkRequest`，`DataNetworkController.addNetworkRequest` 接收后也会触发网络请求评估。

### 8.4 切换时序

在典型的 DDS 切换场景中，数据去激活和重新激活的时序：

```
t0: setDefaultDataSubId(newSubId)
t1: MultiSimSettingController 关闭旧卡数据
    → 旧卡 DataNetworkController 拆除旧卡数据网络
t2: PhoneSwitcher 发送 RIL 命令 (setDataAllowed 或 setPreferredDataModem)
    → modem 切换数据通道
t3: 新卡 DataSettingsManager 收到 DDS 变化通知
    → updateDataEnabledAndNotify(OVERRIDE)
    → 新卡 DataNetworkController 建立新卡数据网络
t4: ConnectivityService 收到活跃数据订阅变化
    → 重新发送 NetworkRequest
    → 新卡 DataNetworkController 评估并建立
```

注意：t1-t4 之间并非严格串行，各组件独立处理回调，存在并行执行的情况。

## 9 自动数据切换（AutoDataSwitchController）

`AutoDataSwitchController` 是 `PhoneSwitcher` 的内部组件，基于信号强度、网络可用性等条件评估是否自动将 DDS 从默认卡切换到另一张卡。

### 9.1 触发评估的条件

| 评估原因 | 说明 |
|---------|------|
| `REGISTRATION_STATE_CHANGED` | 注册状态变化 |
| `DISPLAY_INFO_CHANGED` | DisplayInfo 变化 |
| `SIGNAL_STRENGTH_CHANGED` | 信号强度变化 |
| `DEFAULT_NETWORK_CHANGED` | 默认网络变化 |
| `DATA_SETTINGS_CHANGED` | 数据设置变化 |
| `SIM_LOADED` | SIM 卡加载完成 |
| `CARRIER_CONFIG_CHANGED` | 运营商配置变化 |
| `RETRY_VALIDATION` | 验证失败后重试 |

### 9.2 评估流程

```
evaluateAutoDataSwitch(reason)
  → onEvaluateAutoDataSwitch(reason)
    → 检查 auto data switch feature 是否启用
    → 获取 defaultDataPhoneId、currentPreferredPhoneId、stickyTargetPhoneId
    → 如果 currentPreferredPhoneId == stickyTargetPhoneId:
        → evaluateSwitchOutOfTarget  // 评估是否应该离开目标
    → 否则:
        → evaluateSwitchToTarget     // 评估是否应该切换到目标
    → startStabilityCheck(targetPhoneId, switchType, needValidation)
      → 延迟一段时间后确认切换（稳定性检查）
      → 通过 callback.onRequireImmediatelySwitchToPhone 通知 PhoneSwitcher
```

### 9.3 稳定性检查

`startStabilityCheck` 不会立即执行切换，而是启动一个定时器（通过 `AlarmManager` 或 `Handler`），等待一段时间后再确认。不同类型的检查有不同的超时时间：

- **可用性切换**：较短的稳定性检查时间
- **RAT/信号强度切换**：需要更长的观察时间

### 9.4 PhoneSwitcher 响应自动切换

`AutoDataSwitchController` 通过 `AutoDataSwitchControllerCallback` 通知 `PhoneSwitcher`：

```java
// PhoneSwitcher.java 构造函数中的回调
mAutoDataSwitchCallback = new AutoDataSwitchControllerCallback(this::post) {
    @Override
    public void onRequireValidation(int targetPhoneId, boolean needValidation) {
        // 需要验证
    }
    @Override
    public void onRequireImmediatelySwitchToPhone(int targetPhoneId, int reason) {
        // 直接切换
    }
    @Override
    public void onRequireCancelAnyPendingAutoSwitchValidation() {
        PhoneSwitcher.this.cancelPendingAutoDataSwitchValidation();
    }
};
```

当不需要验证时（例如用户关闭了自动数据切换设置），`onRequireImmediatelySwitchToPhone(DEFAULT_PHONE_INDEX, ...)` 被调用，表示立即切回默认卡。

## 10 紧急 DDS 覆盖

在 DSDS 设备上，某些紧急呼叫场景需要临时切换 DDS 到另一张 SIM 卡：

### 10.1 触发场景

- 非 DDS 的 modem 不支持处理 GNSS SUPL 请求
- 某些运营商不提供控制平面回退机制，SUPL 请求会被丢弃
- 需要在紧急呼叫前临时交换 DDS 以获取用户位置

### 10.2 overrideDefaultDataForEmergency

```java
// PhoneSwitcher.java
public void overrideDefaultDataForEmergency(int phoneId, int overrideTimeSec,
        CompletableFuture<Boolean> dataSwitchResult) {
    Message msg = obtainMessage(EVENT_OVERRIDE_DDS_FOR_EMERGENCY);
    EmergencyOverrideRequest request = new EmergencyOverrideRequest();
    request.mPhoneId = phoneId;
    request.mGnssOverrideTimeMs = overrideTimeSec * 1000;
    request.mOverrideCompleteFuture = dataSwitchResult;
    msg.obj = request;
    msg.sendToTarget();
}
```

发送 `EVENT_OVERRIDE_DDS_FOR_EMERGENCY` 消息，Handler 处理后：

1. 设置 `mEmergencyOverride`，标记紧急覆盖状态
2. 调用 `onEvaluate()` 重新评估
3. `updatePreferredDataPhoneId` 检测到紧急覆盖，将 `mPreferredDataPhoneId` 设为覆盖目标 Phone
4. `sendRilCommands` 发送对应的 RIL 命令完成切换

### 10.3 覆盖恢复

紧急呼叫结束后，通过 `EVENT_REMOVE_DDS_EMERGENCY_OVERRIDE` 消息清除 `mEmergencyOverride`，再次触发 `onEvaluate()`，DDS 恢复到用户设定的默认值。

## 11 完整调用链汇总

### 手动 DDS 切换调用链（从 setDefaultDataSubId 到 Modem）

| 步骤 | 类 | 方法/事件 | 关键动作 |
|------|-----|----------|----------|
| 1 | SubscriptionManagerService | setDefaultDataSubId | 设置新默认数据订阅 ID |
| 2 | SubscriptionManagerService | remapRafIfApplicable | 重映射 Radio Access Family |
| 3 | MultiSimSettingController | notifyDefaultDataSubChanged | 通知多 SIM 控制器 |
| 4 | MultiSimSettingController | disableDataForNonDefaultNonOpportunisticSubscriptions | 关闭旧卡用户数据 |
| 5 | DataSettingsManager | setDataEnabled(USER, false) | 旧卡数据关闭 |
| 6 | DataNetworkController | onDataEnabledChanged(false) | 旧卡触发数据网络评估 |
| 7 | DataNetwork | tearDown(DATA_DISABLED) | 旧卡拆除数据网络 |
| 8 | DataServiceManager | deactivateDataCall | 旧卡去激活数据呼叫 |
| 9 | PhoneSwitcher | evaluateIfImmediateDataSwitchIsNeeded | 评估是否需要立即切换 |
| 10 | PhoneSwitcher | onEvaluate → updatePreferredDataPhoneId | 更新首选数据 Phone |
| 11 | PhoneSwitcher | activate/deactivate | 激活新 Phone / 去激活旧 Phone |
| 12 | PhoneSwitcher | sendRilCommands | 发送 RIL 命令到 modem |
| 13 | RIL / RadioConfig | setDataAllowed 或 setPreferredDataModem | modem 层数据切换 |
| 14 | DataSettingsManager | onDefaultDataSubscriptionChanged | 新卡重新评估数据策略 |
| 15 | DataNetworkController | onDataEnabledChanged(true) | 新卡触发数据建立 |
| 16 | DataNetwork | setupDataCall | 新卡建立数据连接 |
| 17 | RIL → RadioDataProxy | setupDataCall → HAL | modem 建立新卡数据呼叫 |

### 自动数据切换调用链

| 步骤 | 类 | 方法 | 关键动作 |
|------|-----|------|----------|
| 1 | AutoDataSwitchController | evaluateAutoDataSwitch | 触发自动切换评估 |
| 2 | AutoDataSwitchController | onEvaluateAutoDataSwitch | 评估信号/可用性 |
| 3 | AutoDataSwitchController | startStabilityCheck | 稳定性检查定时器 |
| 4 | AutoDataSwitchController | onRequireImmediatelySwitchToPhone | 确认切换 |
| 5 | PhoneSwitcher | setAutoSelectedDataSubIdInternal | 更新自动选择的 subId |
| 6 | PhoneSwitcher | onEvaluate | 重新评估 Phone 激活状态 |
| 7 | PhoneSwitcher | sendRilCommands | 发送 RIL 命令 |

### 紧急 DDS 覆盖调用链

| 步骤 | 类 | 方法 | 关键动作 |
|------|-----|------|----------|
| 1 | PhoneSwitcher | overrideDefaultDataForEmergency | 设置紧急覆盖请求 |
| 2 | PhoneSwitcher | updatePreferredDataPhoneId | mPreferredDataPhoneId 设为紧急 Phone |
| 3 | PhoneSwitcher | onEvaluate | 重新评估 |
| 4 | PhoneSwitcher | sendRilCommands | 发送 RIL 命令 |
| 5 | PhoneSwitcher | EVENT_REMOVE_DDS_EMERGENCY_OVERRIDE | 紧急结束后恢复 |