---
title: "Android 开机 SIM 卡账户（SubscriptionInfo）初始化加载与数据更新"
date: "2025-06-27"
summary: "从 SIM 卡加载完成到 SubscriptionInfo 数据完全就绪的完整流程分析，涵盖 SubscriptionManagerService 初始化、SubscriptionController 数据库操作、CarrierInfoUtils 运营商识别、SIM 卡数据更新与系统广播通知。"
category: "sim-card"
tags: ["SubscriptionManagerService", "SubscriptionController", "SubscriptionInfo", "CarrierInfoUtils", "SIM", "IccRecords", "TelephonyProvider", "SimInfo", "SubId", "CarrierId"]
featured: true
---

---

## 第 1 章 概述

### 1.1 SubscriptionInfo 在系统中的角色

`SubscriptionInfo` 是 Android Telephony 框架中描述 SIM 卡订阅信息的核心数据结构。每当用户插入一张 SIM 卡，系统都会在 `SimInfo` 数据库表中创建一条对应的订阅记录（Subscription），并以唯一的 `subId` 标识。这条记录贯穿了通信子系统的大部分功能：

- **来电/去电路由**：通过 `SubscriptionInfo` 中的 `subId` 确定使用哪张卡拨打电话
- **短信收发**：SMS/MMS 服务依据默认 `subId` 选择发送通道
- **数据连接**：移动数据网络绑定到特定 `subId`，双卡场景下通过 `SubscriptionInfo` 决定数据卡
- **运营商识别**：`mccMnc`、`countryIso`、`carrierId` 等字段用于识别运营商并加载对应配置
- **系统设置**：Settings 应用展示的 SIM 卡名称、号码、运营商信息均来自 `SubscriptionInfo`

简言之，`SubscriptionInfo` 是系统理解"当前有哪些 SIM 卡可用、每张卡属于哪个运营商、提供哪些服务"的数据基础。

### 1.2 与前文的衔接

本文是前文《Android 开机 SIM 卡加载完成全流程技术文档》的续篇。前文覆盖了从 Modem 上报 SIM 状态到 `UiccCardApplication` 变为 `APPSTATE_READY` 的完整过程。本文的起点精确衔接前文末尾所述的 `UiccProfile.updateExternalState()` 调用：

```
前文终点：
  UiccCardApplication 状态变为 APPSTATE_READY
  → notifyReadyRegistrantsIfNeeded()
  → UiccProfile 收到 EVENT_APP_READY
  → updateExternalState()
  → setExternalState(READY)

本文起点：
  UiccProfile.setExternalState(READY)
  → UiccController.updateSimState()
  → SubscriptionManagerService.updateSimState()
  → updateSubscription()  [第一次：READY 阶段]
  → SIMRecords.fetchSimRecords() [文件读取]
  → UiccProfile.setExternalState(LOADED)
  → UiccController.updateSimState()
  → SubscriptionManagerService.updateSimState()
  → updateSubscription()  [第二次：LOADED 阶段]
  → 广播通知上层
```

### 1.3 整体流程总览

从 `READY` 到最终广播通知，整体流程可分为四个阶段：

```
阶段一：READY 状态推进与首次订阅更新
  UiccProfile.setExternalState(READY)
  → UiccController.updateSimState(READY)
  → SubscriptionManagerService.updateSubscription()
    · 创建/更新订阅记录
    · 设置 simSlotIndex、iccId、cardString 等基础字段
    · 不填充 mccMnc/imsi 等运营商数据
    · updateSubscription() 末尾无条件调用 areAllSubscriptionsLoaded()（该方法不检查运营商信息，READY 本身不会导致返回 false）

阶段二：SIM 文件读取
  IccRecords.onReady() → SIMRecords.fetchSimRecords()
  → 20+ 个 EF 文件异步读取
  → mRecordsToLoad 计数递减
  → SIMRecords.onAllRecordsLoaded()

阶段三：LOADED 状态推进与二次订阅更新
  UiccProfile.setExternalState(LOADED)
  → UiccController.updateSimState(LOADED)
  → SubscriptionManagerService.updateSubscription()
    · 查找/创建订阅记录
    · 额外填充 mccMnc、countryIso、displayNumber、imsi、ehplmns、hplmns
    · areAllSubscriptionsLoaded() → MultiSimSettingController 通知
    · updateDefaultSubId()

阶段四：广播通知
  callback 触发：
  → broadcastSimStateChanged(LOADED)
  → broadcastSimCardStateChanged(PRESENT)
  → broadcastSimApplicationStateChanged(LOADED)
  → TelephonyRegistryManager.notifySubscriptionInfoChanged()
  → ACTION_SUBSCRIPTION_INFO_CHANGED
```

### 1.4 架构演进说明

在 Android 13 及更早版本中，订阅信息的更新由独立的 `SubscriptionInfoUpdater` 类负责，该类通过 `SubscriptionUpdatorThread` 线程处理订阅更新逻辑，并依赖 `ACTION_INTERNAL_SIM_STATE_CHANGED` 广播在组件间传递状态变化。

从 Android 14 开始，Google 进行了架构整合：

| 特性 | Android 13 及更早 | Android 14+ |
|------|-------------------|-------------|
| 订阅更新入口 | `SubscriptionInfoUpdater` | `SubscriptionManagerService` |
| 处理线程 | `SubscriptionUpdatorThread` | `SubscriptionManagerService` 内部 WorkerHandler |
| 状态传递机制 | `ACTION_INTERNAL_SIM_STATE_CHANGED` 广播 | `IUpdateSubscriptionStatusCallback` 回调接口 |
| 数据库管理 | 分散在多个类中 | `SubscriptionDatabaseManager` 统一管理 |
| 调用模式 | 广播驱动，松耦合 | Executor + Callback，紧耦合可追踪 |

本文基于 Android 14+ 架构进行描述，所有代码引用均对应 AOSP Android 14 及以上版本。

---

## 第 2 章 关键类与数据结构

### 2.1 SubscriptionManagerService（核心订阅管理服务）

`SubscriptionManagerService` 是 Android 14+ 中订阅管理的核心服务，由 `TelephonyProvider` 在系统启动时创建。它整合了旧版 `SubscriptionInfoUpdater` 的全部功能，负责：

- 接收 `UiccController` 发来的 SIM 状态变化通知
- 管理订阅记录的创建、更新和删除
- 协调 `SubscriptionDatabaseManager` 完成数据库操作
- 通过 `TelephonyRegistryManager` 广播订阅变化
- 驱动 `MultiSimSettingController` 完成默认订阅选择

关键方法签名：

```java
// 框架层调用入口（由 UiccController 通过 AIDL 调用）
public void updateSimState(int slotIndex, @SimState int simState,
        @NonNull Executor executor, @NonNull IUpdateSubscriptionStatusCallback callback);

// 核心订阅更新逻辑
private void updateSubscription(int slotIndex, @SimState int simState);

// 默认订阅更新
private void updateDefaultSubId();
```

线程模型：`SubscriptionManagerService` 在其内部的 `WorkerHandler` 线程上处理所有订阅更新操作，与 `UiccProfile`/`UiccController` 所在的线程隔离，通过 `Executor` 机制完成跨线程回调。

### 2.2 SubscriptionDatabaseManager（全内存缓存数据库管理器）

`SubscriptionDatabaseManager` 是 `SimInfo` 表的全内存缓存管理器，由 `TelephonyProvider` 初始化时创建。其核心设计思想是"全内存缓存 + 延迟写回"：

```
┌──────────────────────────────────────────────┐
│         SubscriptionDatabaseManager          │
│  ┌──────────────────────────────────────────┐ │
│  │     mAllSubscriptionInfoCache (内存缓存)  │ │
│  │     Map<Integer, SubscriptionInfoInternal>│ │
│  │     Key: subId                           │ │
│  └──────────────────┬───────────────────────┘ │
│                     │                         │
│  ┌──────────────────┴───────────────────────┐ │
│  │     SimInfo ContentValues 写入            │ │
│  │     → ContentResolver.update()/insert()  │ │
│  │     → TelephonyProvider → SQLite DB       │ │
│  └──────────────────────────────────────────┘ │
│                                               │
│  ReadWriteLock: 读操作共享锁 / 写操作独占锁    │
└──────────────────────────────────────────────┘
```

核心特性：

- **全内存缓存**：所有订阅信息在初始化时从数据库加载到内存，后续查询直接访问内存，不触发数据库读取
- **同步写入**：`insertSubscriptionInfo()` 是同步操作，调用返回时数据已持久化到数据库
- **组同步机制**：通过 `writeDatabaseAndCacheHelper()` 统一执行数据库写入和缓存更新，使用 `ReadWriteLock` 保证线程安全
- **监听器通知**：写入完成后通过 `OnSubscriptionsChangedListener` 通知观察者

### 2.3 SubscriptionInfoInternal（完整订阅数据模型）

`SubscriptionInfoInternal` 是 `SimInfo` 数据库表行的完整映射，包含所有字段。它使用 Builder 模式构建，既服务于内部订阅管理逻辑，也作为构建面向应用的 `SubscriptionInfo` 的数据源。

关键字段包括但不限于：`subId`、`simSlotIndex`、`iccId`、`cardString`、`displayName`、`carrierName`、`mccMnc`、`countryIso`、`imsi`、`displayNumber`、`ehplmns`、`hplmns`、`carrierId`、`cardId`、`portIndex` 等。

### 2.4 SubscriptionInfo（面向应用层的订阅信息子集）

`SubscriptionInfo` 是通过 `@SystemApi` 和 `@Hide` 注解控制访问的公共 API 类。它从 `SubscriptionInfoInternal` 构建而来，但经过权限过滤，仅暴露安全字段给上层应用。应用通过 `SubscriptionManager.getActiveSubscriptionInfoList()` 获取的即为此对象。

`SubscriptionInfo` 与 `SubscriptionInfoInternal` 的关系：

```
SubscriptionInfoInternal（全量数据）
    │
    ├── 权限过滤
    ├── 字段裁剪（移除 imsi、ehplmns 等敏感字段）
    │
    └── SubscriptionInfo（面向应用的安全子集）
```

### 2.5 UiccController（SIM 状态广播中心）

`UiccController` 是 UICC 层与订阅层之间的桥梁。`updateSimState()` 是其核心桥接方法，负责将 SIM 状态变化同步到 `SubscriptionManagerService` 和 `TelephonyManager`。

```java
// UiccController 中的关键方法
public void updateSimState(int phoneId, @SimState int state, String reason) {
    // 1. 更新系统属性
    SystemProperties.set("gsm.sim.state", phoneId, stateToString(state));

    // 2. 通知 TelephonyManager
    TelephonyManager.setSimStateForPhone(phoneId, stateToString(state));

    // 3. 通过 executor + callback 调用 SubscriptionManagerService
    SubscriptionManagerService.updateSimState(slotIndex, state,
            executor, callback);
}
```

### 2.6 TelephonyRegistryManager / TelephonyRegistry（系统广播桥接）

`TelephonyRegistryManager` 是 Telephony 模块向系统广播层注册通知的接口类，`TelephonyRegistry` 是其实现。二者共同构成"Framework 服务 -- 系统广播"的桥接层：

- `TelephonyRegistryManager.notifySubscriptionInfoChanged()`：触发 `ACTION_SUBSCRIPTION_INFO_CHANGED` 广播
- `TelephonyRegistryManager.notifySimStateChanged()`：触发 `ACTION_SIM_STATE_CHANGED` 广播
- `TelephonyRegistryManager.notifySimCardStateChanged()`：触发 `ACTION_SIM_CARD_STATE_CHANGED` 广播

### 2.7 SimInfo 数据库表结构

`SimInfo` 表位于 `TelephonyProvider` 管理的数据库中（URI: `content://telephony/siminfo`），其核心字段如下：

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `_id` (subId) | INTEGER | 订阅 ID，自增主键 |
| `sim_id` | INTEGER | 关联的卡槽索引 |
| `icc_id` | TEXT | SIM 卡 ICCID |
| `sim_id` (slotIndex) | INTEGER | 卡槽编号 |
| `display_name` | TEXT | 用户自定义显示名称 |
| `carrier_name` | TEXT | 运营商名称 |
| `mcc_mnc` | TEXT | 移动国家码 + 移动网络码 |
| `country_iso` | TEXT | 国家 ISO 代码 |
| `imsi` | TEXT | 国际移动用户识别码 |
| `number` | TEXT | 电话号码 |
| `ehplmns` | TEXT | 等效 HPLMN 列表 |
| `hplmns` | TEXT | 归属 PLMN 列表 |
| `card_id` | INTEGER | 卡片 ID（支持 eSIM 多卡） |
| `port_index` | INTEGER | 端口索引（MEP 场景） |
| `carrier_id` | INTEGER | 运营商 ID |
| `group_uuid` | TEXT | 订阅组 UUID |

### 2.8 MultiSimSettingController（多卡设置控制器）

`MultiSimSettingController` 在所有 SIM 卡的订阅信息加载完成后被通知，负责：

- 管理默认语音/短信/数据订阅的选择
- 处理双卡切换逻辑
- 协调 `PhoneSwitcher`、`TelephonyNetworkMonitor` 等组件的订阅切换
- 在 `areAllSubscriptionsLoaded()` 返回 `true` 后被触发

---

## 第 3 章 从 READY 到 LOADED 的状态推进

### 3.1 UiccCardApplication 状态变为 APPSTATE_READY 触发链路

当 `UiccCardApplication` 的内部状态机从 `APPSTATE_DETECTED` 推进到 `APPSTATE_READY` 时（意味着 PIN/PUK 验证已通过，SIM 卡应用可正常通信），将触发以下调用链：

```
UiccCardApplication.setState(APPSTATE_READY)
  → setStateInternal(APPSTATE_READY)
    → m AppState = APPSTATE_READY
    → notifyReadyRegistrantsIfNeeded()
      → mReadyRegistrants.notifyRegistrants()
```

`notifyReadyRegistrantsIfNeeded()` 会通知所有注册了"就绪"事件的监听者，其中最重要的是 `UiccProfile`。

### 3.2 UiccProfile.updateExternalState() -- setExternalState(READY)

`UiccProfile` 作为 `UiccCardApplication` 的就绪监听者，收到 `EVENT_APP_READY` 后执行 `updateExternalState()`：

```java
// UiccProfile.java
private void updateExternalState() {
    // 检查所有 Application 是否就绪
    if (!areAllApplicationsReady()) {
        // 尚未全部就绪，不推进状态
        return;
    }
    // 检查所有记录是否加载完成
    if (areAllRecordsLoaded() && areCarrierPrivilegeRulesLoaded()) {
        setExternalState(EXTernalState.LOADED);
    } else {
        setExternalState(EXTernalState.READY);
    }
}
```

关键判断逻辑：

- `areAllApplicationsReady()` -- 所有 `UiccCardApplication` 均为 `APPSTATE_READY`
- `areAllRecordsLoaded()` -- 所有 `IccRecords` 均标记为已加载（此时为 `false`，因为尚未开始文件读取）
- `areCarrierPrivilegeRulesLoaded()` -- 运营商特权规则已加载

因为此时 `areAllRecordsLoaded()` 返回 `false`，所以状态只会推进到 `READY`，而不会直接跳到 `LOADED`。

### 3.3 READY 状态下 UiccController.updateSimState() 的调用与 updateSubscription() 的行为

这是本文最关键的内容之一。`READY` 状态下，`UiccProfile.setExternalState(READY)` 也会调用 `UiccController.updateSimState()`，进而触发 `SubscriptionManagerService.updateSubscription()`。

#### 3.3.1 updateSimState() 在 READY 时的回调触发

```java
// UiccProfile.java
private void setExternalState(EXTernalState newState) {
    if (mExternalState != newState) {
        mExternalState = newState;
        // 通知 UiccController 状态变化
        if (mUiccController != null) {
            mUiccController.updateSimState(mPhoneId, newState, null);
        }
    }
}
```

`UiccController.updateSimState()` 收到 `READY` 状态后：

```java
// UiccController.java
public void updateSimState(int phoneId, @SimState int state, String reason) {
    int slotIndex = phoneId;

    // 1. 更新系统属性
    SystemProperties.set("gsm.sim.state", slotIndex, simStateToString(state));

    // 2. 通知 TelephonyManager（同步）
    TelephonyManager.setSimStateForPhone(phoneId, simStateToString(state));

    // 3. 通过 executor + callback 调用 SubscriptionManagerService
    IUpdateSubscriptionStatusCallback callback = new IUpdateSubscriptionStatusCallback.Stub() {
        @Override
        public void onUpdateSubscriptionStatusComplete() {
            // 回调在 executor 线程执行
            // 发送广播
            broadcastSimStateChanged(slotIndex, state);
            broadcastSimCardStateChanged(slotIndex, PRESENT);
            broadcastSimApplicationStateChanged(slotIndex, state);
        }
    };
    mSubscriptionManagerService.updateSimState(slotIndex, state,
            mExecutor, callback);
}
```

**注意**：此处使用了 `executor + callback` 模式。`SubscriptionManagerService.updateSimState()` 的订阅更新操作通过 `executor` 异步执行，待更新完成后回调 `callback`，才发送 SIM 状态广播。这确保了广播发出时订阅数据已经更新完毕。

#### 3.3.2 SubscriptionManagerService.updateSimState() 对 READY 状态的处理

```java
// SubscriptionManagerService.java
public void updateSimState(int slotIndex, @SimState int simState,
        @NonNull Executor executor,
        @NonNull IUpdateSubscriptionStatusCallback callback) {
    // 将任务投递到内部 WorkerHandler
    mHandler.post(() -> {
        updateSubscription(slotIndex, simState);
        // 更新完成后，通过 executor 执行回调
        executor.execute(() -> {
            try {
                callback.onUpdateSubscriptionStatusComplete();
            } catch (RemoteException e) { }
        });
    });
}
```

#### 3.3.3 updateSubscription() 在 READY 状态下做了什么

`updateSubscription()` 是核心方法，其行为随 `simState` 参数不同而有显著差异。当 `simState == SIM_STATE_READY` 时：

```java
// SubscriptionManagerService.java（简化）
private void updateSubscription(int slotIndex, @SimState int simState) {
    switch (simState) {
        case SIM_STATE_ABSENT:
            // 处理卡不在位 ...
            break;
        case SIM_STATE_NOT_READY:
            // 处理卡未就绪 ...
            break;
        case SIM_STATE_READY:
        case SIM_STATE_LOADED:
            // 有卡处理核心分支
            handleSimStatePresent(slotIndex, simState);
            break;
        // ...
    }
}
```

在 `READY` 阶段，`handleSimStatePresent()` 执行的操作包括：

1. **获取 ICCID**：通过 `UiccController.getIccId(slotIndex)` 获取当前卡的 ICCID
2. **创建或查找订阅记录**：
   - 如果是新卡（数据库中无匹配 ICCID），调用 `insertSubscriptionInfo()` 创建新记录
   - 如果是旧卡（数据库中已有匹配 ICCID），查找并复用已有 `subId`
3. **设置基础字段**：
   - `simSlotIndex = slotIndex`
   - `iccId = 当前 ICCID`
   - `cardString = UiccCard 的 cardString`
4. **不填充运营商信息**：关键限制 -- `READY` 状态下不会设置 `mccMnc`、`countryIso`、`imsi`、`displayNumber`、`ehplmns`、`hplmns` 等字段
5. **触发加载完成检查**：`READY` 状态也会调用 `areAllSubscriptionsLoaded()`，但`areAllSubscriptionsLoaded()` 的实现不检查运营商信息是否填充，READY 状态本身也不会导致其返回 false

#### 3.3.4 READY 与 LOADED 状态调用 updateSubscription 的关键区别

这是理解 SubscriptionInfo 初始化过程的核心。`updateSubscription()` 在 `READY` 和 `LOADED` 两种状态下都会被调用，但其行为存在关键差异：

| 对比维度 | READY 阶段 | LOADED 阶段 |
|---------|-----------|------------|
| **触发时机** | UiccCardApplication 变为 APPSTATE_READY 后，setExternalState(READY) 触发 | SIMRecords.onAllRecordsLoaded() 后，setExternalState(LOADED) 触发 |
| **记录是否已存在** | 可能是新卡首次创建，也可能是旧卡复用 | 必定已存在（READY 阶段已创建） |
| **基础字段设置** | simSlotIndex, iccId, cardString, cardId, portIndex | 这些字段已设置，不会重复写入 |
| **运营商数据填充** | **不填充** mccMnc, countryIso, imsi, displayNumber, ehplmns, hplmns | **额外填充** mccMnc, countryIso, imsi, displayNumber, ehplmns, hplmns |
| **SIM 备份恢复** | 不执行 | 执行（SIM_BACKUP_RESTORE_ACQUIRED） |
| **areAllSubscriptionsLoaded()** | **也会调用**（updateSubscription() 末尾无条件调用），`areAllSubscriptionsLoaded()` 本身不检查运营商信息，READY 状态不会导致返回 false | **也会调用**（同一位置无条件调用），此时运营商信息已完整填充，但返回 true 的关键条件是所有 slot 无 UNKNOWN/NOT_READY 状态 |
| **updateDefaultSubId()** | 不调用 | 调用，更新默认订阅 |
| **运营商服务更新** | 不触发 | 触发 resolveSubscriptionCarrierId() 和 updateCarrierServices() |
| **广播内容** | broadcastSimStateChanged(READY) | broadcastSimStateChanged(LOADED) |

这种两阶段设计的原因是：

- **READY 阶段**：SIM 卡刚验证完 PIN 码，`IccRecords` 中的 EF 文件尚未读取完成，`mccMnc`、`imsi` 等数据尚不可用。此时仅需要建立订阅记录的"骨架"，让系统知道"这个卡槽有卡存在"。
- **LOADED 阶段**：所有 EF 文件读取完成，运营商信息已可用。此时在 READY 骨架的基础上，填充完整的运营商数据，使订阅记录完全可用。

#### 3.3.5 READY 状态广播的发送

在 `updateSubscription()` 完成后，`UiccController` 的 callback 被触发，发送以下广播：

```
1. broadcastSimStateChanged(slotIndex, READY)
   → Intent: ACTION_SIM_STATE_CHANGED
   → Extra: ss = "READY"

2. broadcastSimCardStateChanged(slotIndex, PRESENT)
   → Intent: ACTION_SIM_CARD_STATE_CHANGED
   → Extra: simStatus = "PRESENT"

3. broadcastSimApplicationStateChanged(slotIndex, READY)
   → Intent: ACTION_SIM_APPLICATION_STATE_CHANGED
   → Extra: simState = "READY"
```

此时 `ACTION_SUBSCRIPTION_INFO_CHANGED` 尚未发送，因为订阅信息不完整。

### 3.4 IccRecords.onReady() -- SIMRecords.fetchSimRecords() 文件读取

`READY` 状态广播发送完毕后，`IccRecords` 开始执行 `onReady()`：

```java
// SIMRecords.java
@Override
public void onReady() {
    fetchSimRecords();
}

private void fetchSimRecords() {
    // 设置需要加载的记录总数
    mRecordsToLoad = 0;

    // 发起 20+ 个 EF 文件读取请求
    mRecordsToLoad += loadEFTransparent(EF_ICC, obtainMessage(EVENT_GET_ICC_DONE));
    mRecordsToLoad += loadEFTransparent(EF_AD, obtainMessage(EVENT_GET_AD_DONE));
    mRecordsToLoad += loadEFLinearFixed(EF_PBR, obtainMessage(EVENT_GET_PBR_DONE));
    mRecordsToLoad += loadEFTransparent(EF_MBI, obtainMessage(EVENT_GET_MBI_DONE));
    // ... EF_SPN, EF_GID1, EF_GID2, EF_MSISDN, EF_CFF, EF_CFIS,
    //     EF_MAILBOX_CPHS, EF_VOICE_MAIL_IND_CPHS, EF_IIDI, EF_CSP_CPHS,
    //     EF_GID1, EF_GID2, EF_PLMN_ACT, EF_OPLMN_ACT, EF_HPPLMN, ...
    //     EF_FDN, EF_SDN, EF_EXT1, EF_EXT2, EF_EXT3, EF_EXT4,
    //     EF_EXT5, EF_EXT6, EF_EXT7, EF_EXT8, EF_EXT_PBR, EF_FD,
    //     EF_SLP, EF_ICCID, EF_MCC_MNC, EF_EHPLMN, EF_HPLMN ...

    if (mRecordsToLoad == 0) {
        // 无需加载任何记录（极少见），直接完成
        onAllRecordsLoaded();
    }
}
```

`fetchSimRecords()` 会向 SIM 卡发起数十个 EF（Elementary File）文件的异步读取请求。每个文件读取完成后通过 `onRecordLoaded()` 将 `mRecordsToLoad` 计数器减一。

### 3.5 mRecordsToLoad 计数机制与文件读取完成

```java
// SIMRecords.java (父类 IccRecords)
protected void onRecordLoaded() {
    mRecordsToLoad--;
    if (mRecordsToLoad == 0 && !mIsRecordsLoaded) {
        mIsRecordsLoaded = true;
        onAllRecordsLoaded();
    }
}
```

`mRecordsToLoad` 采用简单的计数器模式：

```
fetchSimRecords() 开始 → mRecordsToLoad = N（N 通常为 20+）
每个 EF 文件读取完成 → onRecordLoaded() → mRecordsToLoad--
mRecordsToLoad == 0 → onAllRecordsLoaded()
```

如果某个文件读取失败，`onRecordErrored()` 也会递减计数器，确保即使部分文件读取失败，流程也能继续推进。

### 3.6 SIMRecords.onAllRecordsLoaded() 触发 EVENT_RECORDS_LOADED

当所有 EF 文件读取完成后，`SIMRecords.onAllRecordsLoaded()` 被调用：

```java
// SIMRecords.java
@Override
protected void onAllRecordsLoaded() {
    // 设置系统属性（运营商信息此时已可用）
    SystemProperties.set("gsm.sim.operator.numeric", getOperatorNumeric());
    SystemProperties.set("gsm.sim.operator.alpha", getOperatorAlphaLong());
    SystemProperties.set("gsm.operator.numeric", getOperatorNumeric());
    SystemProperties.set("gsm.operator.alpha", getOperatorAlphaLong());
    SystemProperties.set("gsm.sim.country.iso", getCountryIso());

    // 通知监听者
    mRecordsLoadedRegistrants.notifyRegistrants();
}
```

`mRecordsLoadedRegistrants` 的监听者中包含 `UiccProfile`，它将收到 `EVENT_RECORDS_LOADED` 消息。

### 3.7 UiccProfile 收到 EVENT_RECORDS_LOADED -- setExternalState(LOADED)

```java
// UiccProfile.java
// EVENT_RECORDS_LOADED 消息处理
case EVENT_RECORDS_LOADED:
    updateExternalState();
    break;

private void updateExternalState() {
    if (!areAllApplicationsReady()) return;

    if (areAllRecordsLoaded() && areCarrierPrivilegeRulesLoaded()) {
        setExternalState(EXTernalState.LOADED);
    } else {
        setExternalState(EXTernalState.READY);
    }
}
```

此时三个条件全部满足：
- `areAllApplicationsReady()` = `true`（Application 早已 READY）
- `areAllRecordsLoaded()` = `true`（刚刚收到 EVENT_RECORDS_LOADED）
- `areCarrierPrivilegeRulesLoaded()` = `true`

因此状态推进到 `LOADED`，进入第 4 章描述的流程。

---

## 第 4 章 从 LOADED 到 SubscriptionManagerService 的状态传递链路

### 4.1 UiccProfile.setExternalState(LOADED) 详解

```java
// UiccProfile.java
private void setExternalState(EXTernalState newState) {
    if (mExternalState == newState) return;
    EXTernalState oldState = mExternalState;
    mExternalState = newState;

    log("setExternalState: " + oldState + " -> " + newState);

    // 更新 MCC/MNC/CountryIso 到系统属性
    if (newState == EXTernalState.LOADED) {
        String mcc = getMcc();
        String mnc = getMnc();
        String countryIso = getCountryIso();
        SystemProperties.set(TelephonyProperties.PROPERTY_ICC_OPERATOR_ISO_COUNTRY,
                countryIso);
        SystemProperties.set(TelephonyProperties.PROPERTY_ICC_OPERATOR_NUMERIC,
                mcc + mnc);
        SystemProperties.set(TelephonyProperties.PROPERTY_ICC_OPERATOR_ALPHA,
                getSpn());
    }

    // 更新 gsm.sim.state 系统属性
    SystemProperties.set(TelephonyProperties.PROPERTY_SIM_STATE,
            Integer.toString(mPhoneId), externalStateToProperty(newState));

    // 通知 UiccController
    if (mUiccController != null) {
        mUiccController.updateSimState(mPhoneId,
                externalStateToSimState(newState), null);
    }
}
```

`setExternalState(LOADED)` 的核心操作：
1. 更新 `mExternalState` 为 `LOADED`
2. 设置运营商相关系统属性（`gsm.sim.operator.numeric`、`gsm.sim.operator.alpha`、`gsm.sim.country.iso`）
3. 更新 `gsm.sim.state` 系统属性为 `LOADED`
4. 调用 `UiccController.updateSimState()` 传递状态变化

### 4.2 UiccController.updateSimState() 详解（executor + callback 模式）

`UiccController.updateSimState()` 是 UICC 层与订阅层之间通信的核心方法，其 executor + callback 模式设计值得深入分析。

```java
// UiccController.java
public void updateSimState(int phoneId, @SimState int state, String reason) {
    int slotIndex = PhoneUtils.getSlotIndexFromPhoneId(phoneId);

    // 1. 更新内部状态映射
    mSimState[slotIndex] = state;

    // 2. 更新系统属性
    SystemProperties.set(TelephonyProperties.PROPERTY_SIM_STATE,
            Integer.toString(slotIndex), simStateToString(state));

    // 3. 同步通知 TelephonyManager（设置 Phone 级别 SIM 状态）
    TelephonyManager.setSimStateForPhone(phoneId, simStateToString(state));

    // 4. 异步通知 SubscriptionManagerService
    if (mSubscriptionManagerService != null) {
        Executor executor = Runnable::run; // 实际使用绑定到 UiccController 线程的 executor
        IUpdateSubscriptionStatusCallback callback =
                new UpdateSubscriptionStatusCallback(slotIndex, state);
        mSubscriptionManagerService.updateSimState(slotIndex, state,
                executor, callback);
    }
}
```

`executor + callback` 模式的设计意图：

```
UiccController 线程                          SubscriptionManagerService 线程
     │                                              │
     │  updateSimState(LOADED)                       │
     │ ─────────────────────────────────────────────→ │
     │                                              │ updateSubscription()
     │                                              │ (数据库读写)
     │                                              │
     │                                              │ executor.execute(callback)
     │ ←─────────────────────────────────────────────│
     │                                              │
     │  callback.onUpdateSubscriptionStatusComplete() │
     │  → broadcastSimStateChanged()                │
     │  → broadcastSimCardStateChanged()            │
     │  → broadcastSimApplicationStateChanged()     │
     │                                              │
```

这种设计确保：
- 订阅数据库更新与 SIM 状态广播严格有序
- 广播发出时订阅数据已完全写入
- 跨线程操作通过明确的 callback 机制可追踪

### 4.3 TelephonyManager.setSimStateForPhone() 的作用

```java
// TelephonyManager.java
public static void setSimStateForPhone(int phoneId, @NonNull String state) {
    TelephonyProperties.sim_state(phoneId, state);
}
```

`setSimStateForPhone()` 将 SIM 状态写入系统属性 `gsm.sim.state.<phoneId>`，供不依赖回调机制的组件（如 `ServiceStateTracker`）通过系统属性快速获取 SIM 状态。

### 4.4 SubscriptionManagerService.updateSimState() 的回调机制

```java
// SubscriptionManagerService.java
public void updateSimState(int slotIndex, @SimState int simState,
        @NonNull Executor executor,
        @NonNull IUpdateSubscriptionStatusCallback callback) {
    // 投递到 WorkerHandler 线程处理
    mHandler.post(() -> {
        try {
            updateSubscription(slotIndex, simState);
        } finally {
            // 无论成功失败，都通过 executor 执行回调
            executor.execute(() -> {
                try {
                    callback.onUpdateSubscriptionStatusComplete();
                } catch (RemoteException e) {
                    loge("onUpdateSubscriptionStatusComplete RemoteException", e);
                }
            });
        }
    });
}
```

关键设计要点：
- `updateSubscription()` 在 `WorkerHandler` 线程上同步执行
- 即使 `updateSubscription()` 抛出异常，callback 仍会通过 `finally` 块被调用
- 回调通过 `executor` 回到调用方的线程执行，避免跨线程问题

---

## 第 5 章 updateSubscription() 订阅信息更新核心流程

### 5.1 状态分发逻辑

`updateSubscription()` 是 `SubscriptionManagerService` 中订阅更新的核心方法，它根据不同的 `simState` 分发到不同的处理分支：

```java
// SubscriptionManagerService.java
private void updateSubscription(int slotIndex, @SimState int simState) {
    logd("updateSubscription: slotIndex=" + slotIndex
            + " simState=" + simStateToString(simState));

    switch (simState) {
        case SIM_STATE_ABSENT:
            handleSimAbsent(slotIndex);
            break;

        case SIM_STATE_NOT_READY:
            handleSimNotReady(slotIndex);
            break;

        case SIM_STATE_READY:
        case SIM_STATE_LOADED:
            handleSimPresent(slotIndex, simState);
            break;

        case SIM_STATE_CARD_IO_ERROR:
            handleSimCardIOError(slotIndex);
            break;

        case SIM_STATE_RESTRICTED:
            handleSimRestricted(slotIndex);
            break;
    }
}
```

### 5.2 ABSENT 状态处理

当 SIM 卡被拔出或不存在时，`handleSimAbsent()` 负责清理：

```java
private void handleSimAbsent(int slotIndex) {
    // 1. 获取当前卡槽关联的 subId
    int[] subIds = getSubIds(slotIndex);

    // 2. 标记所有关联订阅为不活跃
    for (int subId : subIds) {
        setSubscriptionActive(subId, false);
    }

    // 3. 清除卡槽索引映射
    clearSlotIndexMapping(slotIndex);

    // 4. 广播订阅变化
    notifySubscriptionChanged();
}
```

### 5.3 NOT_READY 状态处理

```java
private void handleSimNotReady(int slotIndex) {
    // 保留订阅记录但标记为不活跃
    int[] subIds = getSubIds(slotIndex);
    for (int subId : subIds) {
        setSubscriptionActive(subId, false);
    }
    notifySubscriptionChanged();
}
```

`NOT_READY` 状态表示卡存在但未就绪（如 PIN 锁定），此时不清除订阅记录，仅标记为不活跃。

### 5.4 有卡状态处理核心流程

`handleSimPresent()` 是 READY 和 LOADED 状态的统一处理入口，也是本文的核心代码：

```java
private void handleSimPresent(int slotIndex, @SimState int simState) {
    // 5.4.1 ICCID 获取与匹配
    String iccId = getIccId(slotIndex);
    if (TextUtils.isEmpty(iccId)) {
        loge("handleSimPresent: iccId is null for slot " + slotIndex);
        return;
    }

    // 5.4.2 新卡插入 / 5.4.3 旧卡复用
    int subId = findSubIdByIccId(iccId);

    if (subId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
        // 新卡：创建订阅记录
        subId = mSubscriptionDatabaseManager.insertSubscriptionInfo(
                iccId, slotIndex);
        logd("handleSimPresent: inserted new subId=" + subId
                + " for iccId=" + iccId);
    } else {
        // 旧卡：复用已有 subId
        logd("handleSimPresent: reusing existing subId=" + subId);
    }

    // 5.4.4 设置 simSlotIndex、cardId、portIndex
    SubscriptionInfoInternal.Builder builder = getSubscriptionInfoBuilder(subId);
    builder.setSimSlotIndex(slotIndex);
    builder.setCardId(getCardId(slotIndex));
    builder.setPortIndex(getPortIndex(slotIndex));
    builder.setIccId(iccId);
    builder.setCardString(getCardString(slotIndex));

    // 5.4.5 LOADED 状态下的额外信息填充
    if (simState == SIM_STATE_LOADED) {
        String mcc = getMcc(slotIndex);
        String mnc = getMnc(slotIndex);
        builder.setMccMnc(mcc + mnc);
        builder.setCountryIso(getCountryIso(slotIndex));
        builder.setDisplayNumber(getDisplayNumber(slotIndex));
        builder.setImsi(getImsi(slotIndex));
        builder.setEhplmns(getEhplmns(slotIndex));
        builder.setHplmns(getHplmns(slotIndex));

        // SIM 备份恢复
        checkAndRestoreSimBackup(subId, slotIndex);

        // 5.5 全部订阅加载完成检查
        if (areAllSubscriptionsLoaded()) {
            mMultiSimSettingController.notifyAllSubscriptionLoaded();
        }

        // 5.6 默认订阅更新
        updateDefaultSubId();
    }

    // 写入数据库
    mSubscriptionDatabaseManager.updateSubscriptionInfo(builder.build());

    // 标记为活跃
    setSubscriptionActive(subId, true);

    // 通知订阅变化
    notifySubscriptionChanged();
}
```

#### 5.4.1 ICCID 获取与匹配

ICCID（Integrated Circuit Card Identifier）是 SIM 卡的唯一标识符，长度通常为 19-20 位数字。`getIccId()` 从 `UiccController` 获取当前卡槽 SIM 卡的 ICCID：

```java
private String getIccId(int slotIndex) {
    UiccCard card = UiccController.getInstance().getUiccCard(slotIndex);
    if (card != null) {
        return card.getIccId();
    }
    return null;
}
```

#### 5.4.2 新卡插入：insertSubscriptionInfo() 详解

当数据库中找不到匹配的 ICCID 时，调用 `SubscriptionDatabaseManager.insertSubscriptionInfo()`：

```java
// SubscriptionDatabaseManager.java
public int insertSubscriptionInfo(String iccId, int slotIndex) {
    // 1. 构建初始 SubscriptionInfoInternal
    SubscriptionInfoInternal info = new SubscriptionInfoInternal.Builder()
            .setIccId(iccId)
            .setSimSlotIndex(slotIndex)
            .setDisplayName("SIM " + (slotIndex + 1))  // 默认名称
            .setCarrierName("")
            .build();

    // 2. 同步写入数据库
    int subId = insertSubscriptionInfoInternal(info);

    // 3. 更新内存缓存
    mAllSubscriptionInfoCache.put(subId, info);

    logd("insertSubscriptionInfo: created subId=" + subId
            + " for iccId=" + iccId);
    return subId;
}
```

新创建的订阅记录仅包含最基本的标识信息（`iccId`、`simSlotIndex`、默认 `displayName`），运营商相关字段全部为空或默认值。

#### 5.4.3 旧卡复用：查找已有订阅记录

```java
private int findSubIdByIccId(String iccId) {
    // 遍历内存缓存中的所有订阅记录
    for (Map.Entry<Integer, SubscriptionInfoInternal> entry
            : mSubscriptionDatabaseManager.getAllSubscriptionInfoCache().entrySet()) {
        if (iccId.equals(entry.getValue().getIccId())) {
            return entry.getKey(); // 返回匹配的 subId
        }
    }
    return SubscriptionManager.INVALID_SUBSCRIPTION_ID;
}
```

旧卡复用场景下，系统不会创建新记录，而是更新已有记录的字段。这确保了用户对 SIM 卡的自定义设置（如名称、铃声、是否启用通话等）在重启后得以保留。

#### 5.4.4 设置 simSlotIndex、cardId、portIndex

```java
builder.setSimSlotIndex(slotIndex);           // 卡槽索引（0, 1, ...）
builder.setCardId(getCardId(slotIndex));       // 卡片 ID（eSIM 多卡场景）
builder.setPortIndex(getPortIndex(slotIndex)); // 端口索引（MEP 场景）
```

这三个字段标识了 SIM 卡的物理位置，其中 `cardId` 和 `portIndex` 是为 eSIM 和 MEP（Multiple Enabled Profiles）场景引入的新概念。

#### 5.4.5 LOADED 状态下的额外信息填充

仅在 `LOADED` 状态下，以下运营商信息才会被填充到订阅记录中：

| 字段 | 数据来源 | 说明 |
|------|---------|------|
| `mccMnc` | `SIMRecords.getMcc()` + `SIMRecords.getMnc()` | 移动国家码 + 移动网络码，用于运营商识别 |
| `countryIso` | `SIMRecords.getCountryIso()` | 国家 ISO 代码（如 "cn"、"us"） |
| `displayNumber` | `SIMRecords.getMsisdnNumber()` | SIM 卡中存储的电话号码 |
| `imsi` | `SIMRecords.getIMSI()` | 国际移动用户识别码（敏感数据） |
| `ehplmns` | `SIMRecords.getEhplmns()` | 等效归属 PLMN 列表 |
| `hplmns` | `SIMRecords.getHplmns()` | 归属 PLMN 列表 |

### 5.5 全部订阅加载完成检查（areAllSubscriptionsLoaded）

```java
private boolean areAllSubscriptionsLoaded() {
    // 检查所有卡槽是否都达到了 LOADED 状态
    for (int i = 0; i < mActiveModemCount; i++) {
        if (mSimState[i] != SIM_STATE_LOADED) {
            return false;
        }
    }
    return true;
}
```

当所有卡槽的 SIM 卡都达到 `LOADED` 状态后：

```java
mMultiSimSettingController.notifyAllSubscriptionLoaded();
```

`MultiSimSettingController` 收到通知后，会：
- 选择默认语音/短信/数据订阅
- 通知 `PhoneSwitcher` 切换数据连接
- 通知 `TelephonyNetworkMonitor` 更新网络配置
- 触发 `DcTracker` 建立数据连接

**重要**：`areAllSubscriptionsLoaded()` 在 `READY` 和 `LOADED` 状态下都会被调用，因为 `updateSubscription()` 方法末尾无条件执行此检查。`areAllSubscriptionsLoaded()` 的实现不检查运营商信息是否填充（mccMnc、imsi 等），READY 状态本身也不会导致其返回 false；它只检查 slot 是否就绪、SIM 状态是否为 UNKNOWN 或 NOT_READY（非最终状态）。因此 READY 状态下如果所有 slot 都已就绪且无 UNKNOWN/NOT_READY 状态，`areAllSubscriptionsLoaded()` 完全可能返回 true。READY 与 LOADED 的真正区别在于：`updateSubscription()` 内部只有 LOADED 才会填充运营商信息，且 UiccController 回调中 READY 被视为非最终状态，不执行运营商 ID 解析和服务更新。

### 5.6 updateDefaultSubId 默认订阅更新

```java
private void updateDefaultSubId() {
    // 1. 查找当前活跃的订阅列表
    List<SubscriptionInfoInternal> activeSubscriptions =
            mSubscriptionDatabaseManager.getActiveSubscriptionInfoList();

    if (activeSubscriptions.isEmpty()) {
        // 无活跃订阅，清除默认 subId
        setDefaultDataSubId(SubscriptionManager.INVALID_SUBSCRIPTION_ID);
        setDefaultVoiceSubId(SubscriptionManager.INVALID_SUBSCRIPTION_ID);
        setDefaultSmsSubId(SubscriptionManager.INVALID_SUBSCRIPTION_ID);
        return;
    }

    // 2. 如果默认 subId 已失效，选择新的默认订阅
    if (!isSubIdActive(getDefaultDataSubId())) {
        // 选择第一个活跃订阅作为默认
        int newDefaultSubId = activeSubscriptions.get(0).getSubscriptionId();
        setDefaultDataSubId(newDefaultSubId);
    }
}
```

---

## 第 6 章 SubscriptionDatabaseManager 数据库操作层

### 6.1 全内存缓存架构设计

`SubscriptionDatabaseManager` 的核心设计理念是"全内存缓存"，其架构如下：

```
┌─────────────────────────────────────────────────────────┐
│              SubscriptionDatabaseManager                 │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │   mAllSubscriptionInfoCache (ConcurrentHashMap)      │ │
│  │   Key: subId (Integer)                              │ │
│  │   Value: SubscriptionInfoInternal                   │ │
│  │                                                      │ │
│  │   初始化时从数据库全量加载                            │ │
│  │   后续所有查询直接访问内存                             │ │
│  └─────────────────────────────────────────────────────┘ │
│                          │                               │
│  ┌───────────────────────┴─────────────────────────────┐ │
│  │              ReadWriteLock                           │ │
│  │   读操作：获取共享锁（多线程并行读）                    │ │
│  │   写操作：获取独占锁（排他写）                         │ │
│  └─────────────────────────────────────────────────────┘ │
│                          │                               │
│  ┌───────────────────────┴─────────────────────────────┐ │
│  │         writeDatabaseAndCacheHelper()               │ │
│  │   1. 构造 ContentValues                             │ │
│  │   2. 获取独占写锁                                    │ │
│  │   3. 更新内存缓存                                    │ │
│  │   4. 通过 ContentResolver 写入数据库                   │ │
│  │   5. 释放写锁                                       │ │
│  │   6. 通知监听器                                     │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 6.2 数据库初始化流程

```java
// SubscriptionDatabaseManager.java
public SubscriptionDatabaseManager(Context context) {
    mContext = context;

    // 从数据库全量加载到内存
    loadAllSubscriptionsFromDatabase();

    // 注册 ContentObserver 监听外部变化
    registerContentObserver();
}

private void loadAllSubscriptionsFromDatabase() {
    Cursor cursor = mContext.getContentResolver().query(
            SimInfo.CONTENT_URI,
            SIMINFO_COLUMN projection,
            null, null, null);

    if (cursor != null) {
        while (cursor.moveToNext()) {
            SubscriptionInfoInternal info =
                    SubscriptionInfoInternal.fromCursor(cursor);
            mAllSubscriptionInfoCache.put(
                    info.getSubscriptionId(), info);
        }
        cursor.close();
    }
    logd("Loaded " + mAllSubscriptionInfoCache.size()
            + " subscriptions from database");
}
```

### 6.3 insertSubscriptionInfo 同步插入

```java
// SubscriptionDatabaseManager.java
public int insertSubscriptionInfo(@NonNull SubscriptionInfoInternal info) {
    // 1. 构造 ContentValues
    ContentValues values = info.toContentValues();

    // 2. 同步写入数据库
    Uri resultUri = mContext.getContentResolver().insert(
            SimInfo.CONTENT_URI, values);

    // 3. 从返回 URI 中提取自增 subId
    int subId = Integer.parseInt(
            resultUri.getLastPathSegment());

    // 4. 设置 subId 并更新缓存
    SubscriptionInfoInternal insertedInfo = new SubscriptionInfoInternal.Builder(info)
            .setSubscriptionId(subId)
            .build();
    mAllSubscriptionInfoCache.put(subId, insertedInfo);

    logd("insertSubscriptionInfo: subId=" + subId);
    return subId;
}
```

关键特性：`insertSubscriptionInfo()` 是**同步操作**，调用返回时数据已持久化到 SQLite 数据库，且内存缓存已更新。

### 6.4 writeDatabaseAndCacheHelper 统一更新机制

```java
// SubscriptionDatabaseManager.java
private boolean writeDatabaseAndCacheHelper(
        @NonNull SubscriptionInfoInternal newInfo) {
    // 1. 获取写锁（独占）
    mReadWriteLock.writeLock().lock();
    try {
        int subId = newInfo.getSubscriptionId();

        // 2. 构造 ContentValues
        ContentValues values = newInfo.toContentValues();

        // 3. 更新数据库
        int rowsUpdated = mContext.getContentResolver().update(
                ContentUris.withAppendedId(SimInfo.CONTENT_URI, subId),
                values, null, null);

        if (rowsUpdated > 0) {
            // 4. 更新内存缓存
            mAllSubscriptionInfoCache.put(subId, newInfo);
            logd("writeDatabaseAndCacheHelper: updated subId=" + subId);
            return true;
        }
        return false;
    } finally {
        // 5. 释放写锁
        mReadWriteLock.writeLock().unlock();
    }
}
```

### 6.5 异步模式 vs 同步模式

`SubscriptionDatabaseManager` 提供两种写入模式：

| 模式 | 方法 | 特点 |
|------|------|------|
| 同步模式 | `insertSubscriptionInfo()` / `updateSubscriptionInfo()` | 调用阻塞直到写入完成，适用于需要立即获取 subId 或确认写入结果的场景 |
| 异步模式 | `updateSubscriptionInfoAsync()` | 内部使用 `AsyncTask` 或 `Handler` 延迟执行，适用于批量更新场景 |

在 SubscriptionInfo 初始化加载流程中，所有操作都使用**同步模式**，确保数据一致性。

---

## 第 7 章 SubscriptionInfoInternal 数据模型

### 7.1 核心字段说明

`SubscriptionInfoInternal` 包含以下核心字段，按功能分组：

**身份标识字段**：

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `subscriptionId` (subId) | int | 数据库自增 | 订阅唯一标识，数据库主键 |
| `iccId` | String | SIM 卡 EF_ICCID | SIM 卡唯一标识 |
| `simSlotIndex` | int | UiccProfile | 卡槽索引 |
| `cardId` | int | UiccCard | 卡片 ID |
| `portIndex` | int | UiccPort | 端口索引（MEP） |

**运营商信息字段**：

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `mccMnc` | String | SIMRecords (EF_AD/EF_MCC_MNC) | 移动国家码 + 移动网络码 |
| `countryIso` | String | SIMRecords (EF_AD) | 国家 ISO 代码 |
| `carrierName` | String | SIMRecords (EF_SPN) | 运营商短名称 |
| `carrierId` | int | CarrierResolver | 运营商数字 ID |
| `imsi` | String | SIMRecords (EF_IMSI) | 国际移动用户识别码 |
| `ehplmns` | String | SIMRecords (EF_EHPLMN) | 等效归属 PLMN 列表 |
| `hplmns` | String | SIMRecords (EF_HPLMN) | 归属 PLMN 列表 |

**用户配置字段**：

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `displayName` | String | 用户设置 | SIM 卡显示名称 |
| `displayNumber` | String | SIMRecords (EF_MSISDN) | 电话号码 |
| `number` | String | 用户设置 | 用户自定义号码 |
| `groupUuid` | String | 系统 | 订阅组 UUID（多卡组） |
| `isEmbedded` | boolean | UiccSlot | 是否为 eSIM |
| `isActive` | boolean | 系统 | 订阅是否激活 |

### 7.2 Builder 模式构建

`SubscriptionInfoInternal` 使用 Builder 模式，支持链式调用：

```java
SubscriptionInfoInternal info = new SubscriptionInfoInternal.Builder()
        // 阶段一：READY 时设置
        .setSubscriptionId(subId)
        .setIccId(iccId)
        .setSimSlotIndex(slotIndex)
        .setCardId(cardId)
        .setPortIndex(portIndex)
        .setCardString(cardString)
        // 阶段二：LOADED 时额外设置
        .setMccMnc(mcc + mnc)
        .setCountryIso(countryIso)
        .setDisplayNumber(displayNumber)
        .setImsi(imsi)
        .setEhplmns(ehplmns)
        .setHplmns(hplmns)
        .build();
```

Builder 模式的优势：
- 清晰区分"必须字段"与"可选字段"
- 支持增量构建（先创建骨架，后续填充）
- 不可变对象，线程安全

### 7.3 与 SubscriptionInfo 的转换关系

`SubscriptionInfo` 是面向应用层的公开 API，通过 `SubscriptionInfoInternal` 转换而来：

```java
// SubscriptionInfo.java (内部构造)
public static SubscriptionInfo createFromSubscriptionInfoInternal(
        SubscriptionInfoInternal internal) {
    return new SubscriptionInfo(
            internal.getSubscriptionId(),    // subId
            internal.getIccId(),              // iccId
            internal.getSimSlotIndex(),       // simSlotIndex
            internal.getDisplayName(),        // displayName
            internal.getCarrierName(),       // carrierName
            internal.getMccMnc(),            // mccMnc
            internal.getCountryIso(),        // countryIso
            false,                           // isEmergencyOnly
            internal.getDisplayNumber(),     // displayNumber
            // ... 其他公开字段
            // 注意：不包含 imsi、ehplmns、hplmns 等敏感字段
    );
}
```

转换过程中的权限过滤：

```
SubscriptionInfoInternal 字段          →    SubscriptionInfo 字段
─────────────────────────────────────────────────────────────
subId                                  →    subId
iccId                                  →    iccId
simSlotIndex                           →    simSlotIndex
displayName                            →    displayName
carrierName                            →    carrierName
mccMnc                                 →    mccMnc
countryIso                             →    countryIso
displayNumber                          →    displayNumber
carrierId                              →    carrierId
─────────────────────────────────────────────────────────────
imsi                                   →    [不包含] 敏感数据
ehplmns                                →    [不包含] 内部数据
hplmns                                 →    [不包含] 内部数据
cardString                             →    [不包含] 内部标识
```

---

## 第 8 章 最终广播通知与上层接收

### 8.1 notifySubscriptionChanged 通知链

在 `updateSubscription()` 完成订阅记录的数据库写入后，`notifySubscriptionChanged()` 被调用以通知系统：

```java
// SubscriptionManagerService.java
private void notifySubscriptionChanged() {
    // 1. 通知 TelephonyRegistryManager
    mTelephonyRegistryManager.notifySubscriptionInfoChanged();

    // 2. 通知内部监听器（如 SubscriptionMonitorService）
    for (OnSubscriptionsChangedListener listener : mListeners) {
        listener.onSubscriptionsChanged();
    }
}
```

### 8.2 三套 SIM 状态广播详解

Android 14+ 中，SIM 状态变化通过三套不同的广播通知，各有不同的语义和用途：

| 广播 Action | 触发者 | 语义 | 典型接收者 |
|-------------|--------|------|-----------|
| `ACTION_SIM_STATE_CHANGED` | UiccController | SIM 卡整体状态变化（ABSENT/NOT_READY/READY/LOADED） | Settings、SystemUI |
| `ACTION_SIM_CARD_STATE_CHANGED` | UiccController | SIM 卡物理状态变化（ABSENT/PRESENT/IO_ERROR） | SystemUI |
| `ACTION_SIM_APPLICATION_STATE_CHANGED` | UiccController | SIM 应用状态变化 | Settings |
| `ACTION_SUBSCRIPTION_INFO_CHANGED` | TelephonyRegistryManager | 订阅信息数据变化 | Settings、Dialer、Messages |

三套广播的发送顺序：

```
updateSubscription() 完成
    ↓
notifySubscriptionChanged()
    → ACTION_SUBSCRIPTION_INFO_CHANGED (TelephonyRegistryManager)
    ↓
callback.onUpdateSubscriptionStatusComplete()
    → ACTION_SIM_STATE_CHANGED (UiccController)
    → ACTION_SIM_CARD_STATE_CHANGED (UiccController)
    → ACTION_SIM_APPLICATION_STATE_CHANGED (UiccController)
```

### 8.3 ACTION_SUBSCRIPTION_INFO_CHANGED 广播

`ACTION_SUBSCRIPTION_INFO_CHANGED` 是上层应用获取订阅信息变化的主要通知方式：

```java
// 应用层监听方式
SubscriptionManager mSubMgr = context.getSystemService(SubscriptionManager.class);
mSubMgr.addOnSubscriptionsChangedListener(
        new SubscriptionManager.OnSubscriptionsChangedListener() {
    @Override
    public void onSubscriptionsChanged() {
        List<SubscriptionInfo> activeSubs =
                mSubMgr.getActiveSubscriptionInfoList();
        // 处理订阅变化
    }
});
```

此广播在 `LOADED` 状态的 `updateSubscription()` 完成后才发送，此时订阅信息中已包含完整的运营商数据。`READY` 阶段虽然也会触发 `updateSubscription()`，但由于此时不调用 `notifySubscriptionChanged()`（或调用但订阅信息不完整），上层应用通常不会做出有意义的响应。

### 8.4 上层应用监听机制

上层应用通过 `SubscriptionManager.OnSubscriptionsChangedListener` 监听订阅变化：

```
SubscriptionManager.addOnSubscriptionsChangedListener(listener)
    ↓
SubscriptionManagerService.registerListener(listener)
    ↓
notifySubscriptionChanged() → listener.onSubscriptionsChanged()
    ↓
listener 调用 SubscriptionManager.getActiveSubscriptionInfoList()
    ↓
SubscriptionManagerService.getAllSubscriptionInfoList()
    ↓
遍历 mAllSubscriptionInfoCache
    → 权限过滤
    → 转换为 SubscriptionInfo
    → 返回给应用
```

### 8.5 运营商 ID 解析与运营商服务更新

在 `LOADED` 状态的 callback 中，除了发送广播外，还会执行运营商相关操作：

```java
// UiccController.java (callback 中)
void onSubscriptionUpdateComplete() {
    broadcastSimStateChanged(LOADED);
    broadcastSimCardStateChanged(PRESENT);
    broadcastSimApplicationStateChanged(LOADED);

    // 仅在 LOADED 时执行
    if (state == SIM_STATE_LOADED) {
        resolveSubscriptionCarrierId();
        updateCarrierServices();
    }
}
```

**resolveSubscriptionCarrierId()**：

```
 mccMnc → CarrierResolver.resolveCarrierId()
     → 查找 CarrierIdentifier 表
     → 匹配运营商 ID (carrierId)
     → 更新 SubscriptionInfoInternal.carrierId
```

**updateCarrierServices()**：

```
 carrierId → CarrierServiceConfig 查找
     → 加载运营商专属配置（APN、MCC-MNC 映射等）
     → 通知 CarrierConfigManager
```

这两个操作依赖 `mccMnc` 数据，因此只能在 `LOADED` 状态执行。

---

## 第 9 章 典型场景分析

### 9.1 正常开机新卡首次加载全流程

场景描述：设备首次开机，插入一张全新的 SIM 卡（数据库中无匹配 ICCID）。

```
[阶段一：UICC 初始化]
Modem 上报 SIM 状态变化
  → UiccController.getIccCardStatus()
  → 创建 UiccSlot → UiccCard → UiccPort → UiccProfile
  → 创建 UiccCardApplication (APPSTATE_READY)
  → IccRecords 创建

[阶段二：READY 状态推进]
UiccProfile.setExternalState(READY)
  → UiccController.updateSimState(READY)
  → TelephonyManager.setSimStateForPhone("READY")
  → SubscriptionManagerService.updateSimState(READY)
  → updateSubscription(READY)
      · getIccId() → "898600xxxxx..."
      · findSubIdByIccId() → NOT_FOUND
      · insertSubscriptionInfo(iccId, slotIndex)
          → 数据库写入 SimInfo
          → 返回 subId = 1
      · setSimSlotIndex(0)
      · setIccId("898600xxxxx...")
      · setCardString("...")
      · [不填充 mccMnc/imsi 等运营商数据]
  → callback: broadcastSimStateChanged(READY)

[阶段三：文件读取]
IccRecords.onReady() → SIMRecords.fetchSimRecords()
  → 读取 EF_ICCID, EF_AD, EF_SPN, EF_MSISDN, EF_IMSI,
    EF_MCC_MNC, EF_EHPLMN, EF_HPLMN ... (20+ 个文件)
  → mRecordsToLoad 递减至 0
  → onAllRecordsLoaded()

[阶段四：LOADED 状态推进]
UiccProfile.setExternalState(LOADED)
  → 更新 gsm.sim.operator.numeric, gsm.sim.operator.alpha 等
  → UiccController.updateSimState(LOADED)
  → SubscriptionManagerService.updateSimState(LOADED)
  → updateSubscription(LOADED)
      · getIccId() → "898600xxxxx..."
      · findSubIdByIccId() → subId = 1 (已找到)
      · setSimSlotIndex(0), setCardId(...), setPortIndex(...)
      · [LOADED] 额外填充:
          setMccMnc("46000")
          setCountryIso("cn")
          setDisplayNumber("13800138000")
          setImsi("460001234567890")
          setEhplmns("46000,46002,46007")
          setHplmns("46000")
      · areAllSubscriptionsLoaded() → true
          → MultiSimSettingController.notifyAllSubscriptionLoaded()
      · updateDefaultSubId()
  → callback:
      · broadcastSimStateChanged(LOADED)
      · ACTION_SUBSCRIPTION_INFO_CHANGED
      · resolveSubscriptionCarrierId()
      · updateCarrierServices()
```

### 9.2 正常开机旧卡复用加载流程

场景描述：设备重启，SIM 卡未更换，数据库中已有该 ICCID 的订阅记录。

```
[READY 阶段]
updateSubscription(READY)
  · getIccId() → "898600xxxxx..."（与数据库中相同）
  · findSubIdByIccId() → subId = 1（已找到，复用）
  · setSimSlotIndex(0), setIccId(...)
  · 不创建新记录，仅更新已有记录的基础字段
  · [不填充运营商数据]

[LOADED 阶段]
updateSubscription(LOADED)
  · findSubIdByIccId() → subId = 1（同一个 subId）
  · 更新运营商数据
  · 恢复用户自定义配置（displayName、groupUuid 等）
```

关键区别：旧卡复用时，`subId` 保持不变，用户之前对 SIM 卡的自定义设置（如名称、铃声、分组）得以保留。

### 9.3 双卡场景下的订阅初始化

场景描述：双卡设备开机，两张 SIM 卡先后完成加载。

```
[卡槽 0 SIM 卡先完成]
  READY → updateSubscription(READY) → subId=1 创建
  LOADED → updateSubscription(LOADED)
    → areAllSubscriptionsLoaded() = false（卡槽 1 未完成）
    → 不通知 MultiSimSettingController

[卡槽 1 SIM 卡随后完成]
  READY → updateSubscription(READY) → subId=2 创建
  LOADED → updateSubscription(LOADED)
    → areAllSubscriptionsLoaded() = true
    → MultiSimSettingController.notifyAllSubscriptionLoaded()
      → 选择默认订阅（通常为卡槽 0）
      → 通知 PhoneSwitcher、DcTracker 等
```

在双卡场景下，`areAllSubscriptionsLoaded()` 检查确保了只有当所有 SIM 卡都完全加载后，系统才开始配置默认订阅和网络连接。

### 9.4 热插拔场景下的订阅更新

场景描述：设备运行中，用户插入一张新的 SIM 卡。

```
[拔出旧卡]
  UiccController.updateSimState(ABSENT)
  → handleSimAbsent(slotIndex)
    · setSubscriptionActive(subId, false)
    · notifySubscriptionChanged()

[插入新卡]
  Modem 上报 SIM 状态变化
  → 创建新的 UiccCardApplication
  → READY → updateSubscription(READY)
    · insertSubscriptionInfo() → 新 subId=3
  → LOADED → updateSubscription(LOADED)
    · 填充运营商数据
    · areAllSubscriptionsLoaded()
    · updateDefaultSubId()
```

热插拔场景的流程与开机基本相同，但需要注意：
- 旧卡的 `subId` 不会被删除，仅标记为不活跃
- 新卡会获得新的 `subId`
- 如果插入的是之前拔出的同一张卡，会复用旧 `subId`

### 9.5 SIM 卡拔出后订阅清除

```
[卡拔出检测]
  UiccSlot.onRemoved()
  → UiccController.updateSimState(ABSENT)
  → SubscriptionManagerService.updateSimState(ABSENT)
  → handleSimAbsent(slotIndex)
    · 获取卡槽关联的 subId 列表
    · setSubscriptionActive(subId, false)
    · clearSlotIndexMapping(slotIndex)
    · notifySubscriptionChanged()
  → ACTION_SUBSCRIPTION_INFO_CHANGED

[重要说明]
  订阅记录不会从数据库中物理删除。
  setSubscriptionActive(false) 仅标记为不活跃，
  当同一张 SIM 卡再次插入时，通过 ICCID 匹配复用。
```

---

## 第 10 章 调试与日志

### 10.1 关键 Log TAG 列表

| TAG | 对应类 | 重点关注 |
|-----|--------|---------|
| `UiccProfile` | `UiccProfile` | 状态推进（READY/LOADED）、记录加载事件 |
| `UiccController` | `UiccController` | updateSimState 调用、广播发送 |
| `SubscriptionManagerService` | `SubscriptionManagerService` | updateSubscription、subId 分配、默认订阅 |
| `SubscriptionDatabaseManager` | `SubscriptionDatabaseManager` | 数据库读写、缓存更新 |
| `SIMRecords` | `SIMRecords` | EF 文件读取、mRecordsToLoad 计数 |
| `IccRecords` | `IccRecords` | onReady、onAllRecordsLoaded |
| `MultiSimSettingController` | `MultiSimSettingController` | 默认订阅选择、全卡加载完成通知 |
| `TelephonyRegistry` | `TelephonyRegistry` | 广播发送记录 |

### 10.2 常用调试命令

```bash
adb shell content query --uri content://telephony/siminfo

adb shell getprop gsm.sim.state
adb shell getprop gsm.sim.state.0
adb shell getprop gsm.sim.state.1

adb shell getprop gsm.sim.operator.numeric
adb shell getprop gsm.sim.operator.alpha
adb shell getprop gsm.sim.country.iso

adb shell getprop gsm.default.subscription
adb shell getprop gsm.sim.operator.numeric

adb logcat -s SubscriptionManagerService:V SubscriptionDatabaseManager:V \
    UiccProfile:V UiccController:V SIMRecords:V

adb shell dumpsys activity broadcasts | grep SUBSCRIPTION

adb shell dumpsys telephonyregistry | grep -A 20 "mSubInfoList"

adb shell content call --uri content://telephony/siminfo --method refresh

adb shell dumpsys isub
```

### 10.3 常见问题排查思路

**问题 1：SIM 卡显示"无 SIM 卡"但物理连接正常**

排查步骤：
```
1. 检查 gsm.sim.state 是否为 ABSENT
   adb shell getprop gsm.sim.state.0

2. 检查 UiccSlot 是否创建了 UiccCard
   adb logcat -s UiccSlot:V | grep "Null card"

3. 检查 Modem 是否正确上报了卡状态
   adb logcat -s RILJ:V | grep "getIccCardStatus"

4. 检查 UiccProfile 是否收到 EVENT_APP_READY
   adb logcat -s UiccProfile:V | grep "EVENT_APP_READY"
```

**问题 2：订阅信息中运营商数据为空（mccMnc/countryIso 为空）**

排查步骤：
```
1. 检查 SIMRecords 是否完成文件读取
   adb logcat -s SIMRecords:V | grep "onAllRecordsLoaded"

2. 检查 EF_MCC_MNC 和 EF_AD 是否读取成功
   adb logcat -s SIMRecords:V | grep "EF_MCC_MNC"
   adb logcat -s SIMRecords:V | grep "EF_AD"

3. 检查状态是否推进到 LOADED
   adb logcat -s UiccProfile:V | grep "LOADED"

4. 检查 updateSubscription 是否在 LOADED 状态下填充了运营商数据
   adb logcat -s SubscriptionManagerService:V | grep "LOADED"
```

**问题 3：areAllSubscriptionsLoaded() 返回 false 导致系统卡住**

排查步骤：
```
1. 检查所有卡槽的状态
   adb shell getprop gsm.sim.state.0
   adb shell getprop gsm.sim.state.1

2. 检查是否有卡槽卡在 READY 状态（未推进到 LOADED）
   adb logcat -s UiccProfile:V | grep "READY"

3. 检查 SIMRecords 文件读取是否超时
   adb logcat -s SIMRecords:V | grep "onRecordErrored"

4. 检查 mRecordsToLoad 是否归零
   adb logcat -s SIMRecords:V | grep "mRecordsToLoad"
```

**问题 4：双卡设备只有一张卡被识别**

排查步骤：
```
1. 检查第二个卡槽的 Radio 是否可用
   adb shell getprop gsm.sim.state.1
   adb logcat -s UiccController:V | grep "RADIO_AVAILABLE"

2. 检查 UiccSlot[1] 是否存在
   adb logcat -s UiccController:V | grep "slotIndex=1"

3. 检查是否为 Modem 层限制（某些 Modem 不支持双卡同时工作）
   adb logcat -s RILJ:V | grep "getIccCardStatus" | grep "slotIndex=1"
```

**问题 5：热插拔后订阅信息未更新**

排查步骤：
```
1. 检查 UiccSlot 是否收到拔出/插入事件
   adb logcat -s UiccSlot:V | grep "onRemoved\|onInserted"

2. 检查 updateSimState 是否被调用
   adb logcat -s UiccController:V | grep "updateSimState"

3. 检查 SubscriptionManagerService 是否收到 ABSENT/LOADED 状态
   adb logcat -s SubscriptionManagerService:V | grep "updateSubscription"

4. 检查 ICCID 匹配逻辑
   adb logcat -s SubscriptionManagerService:V | grep "findSubIdByIccId"
```

---

## 附录 A 核心类源码路径速查

| 类名 | AOSP 源码路径（相对于 frameworks/opt/telephony/） | 说明 |
|------|--------------------------------------------------|------|
| `UiccProfile` | `src/java/com/android/internal/telephony/uicc/UiccProfile.java` | 外部状态机核心 |
| `UiccController` | `src/java/com/android/internal/telephony/uicc/UiccController.java` | SIM 状态广播中心 |
| `UiccCardApplication` | `src/java/com/android/internal/telephony/uicc/UiccCardApplication.java` | SIM 卡应用 |
| `IccRecords` | `src/java/com/android/internal/telephony/uicc/IccRecords.java` | ICC 记录基类 |
| `SIMRecords` | `src/java/com/android/internal/telephony/uicc/SIMRecords.java` | SIM 记录实现 |
| `UiccSlot` | `src/java/com/android/internal/telephony/uicc/UiccSlot.java` | 物理卡槽 |
| `UiccCard` | `src/java/com/android/internal/telephony/uicc/UiccCard.java` | 逻辑卡片 |
| `UiccPort` | `src/java/com/android/internal/telephony/uicc/UiccPort.java` | 卡片端口 |
| `SubscriptionManagerService` | `src/java/com/android/internal/telephony/subscription/SubscriptionManagerService.java` | 订阅管理服务 |
| `SubscriptionDatabaseManager` | `src/java/com/android/internal/telephony/subscription/SubscriptionDatabaseManager.java` | 数据库缓存管理 |
| `SubscriptionInfoInternal` | `src/java/com/android/internal/telephony/subscription/SubscriptionInfoInternal.java` | 订阅数据模型 |
| `MultiSimSettingController` | `src/java/com/android/internal/telephony/MultiSimSettingController.java` | 多卡设置控制器 |
| `TelephonyRegistryManager` | `src/java/com/android/internal/telephony/TelephonyRegistryManager.java` | 系统广播桥接接口 |
| `TelephonyRegistry` | `src/java/com/android/telephony/TelephonyRegistry.java` | 系统广播桥接实现 |

| 类名 | AOSP 源码路径（相对于 frameworks/base/） | 说明 |
|------|------------------------------------------|------|
| `SubscriptionInfo` | `telephony/java/android/telephony/SubscriptionInfo.java` | 面向应用的订阅信息 |
| `SubscriptionManager` | `telephony/java/android/telephony/SubscriptionManager.java` | 订阅管理器公共 API |
| `TelephonyManager` | `telephony/java/android/telephony/TelephonyManager.java` | 电话管理器公共 API |

| 类名 | AOSP 源码路径（相对于 packages/services/Telephony/） | 说明 |
|------|------------------------------------------------------|------|
| `TelephonyProvider` | `src/com/android/providers/telephony/TelephonyProvider.java` | SimInfo ContentProvider |

---

## 附录 B SimInfo 数据库表字段完整列表

| 字段名 | 列名 | 类型 | 说明 | 填充阶段 |
|--------|------|------|------|---------|
| 订阅 ID | `_id` (subId) | INTEGER (PK) | 订阅唯一标识，自增 | 创建时 |
| SIM 卡标识 | `icc_id` | TEXT | ICCID | READY |
| 卡槽索引 | `sim_id` | INTEGER | simSlotIndex | READY |
| 显示名称 | `display_name` | TEXT | 用户自定义名称 | READY |
| 运营商名称 | `carrier_name` | TEXT | 运营商短名称 | LOADED |
| 颜色 | `name_source` | INTEGER | 名称来源枚举 | READY |
| 号码显示 | `number` | TEXT | 电话号码 | LOADED |
| 数据漫游 | `data_roaming` | INTEGER | 数据漫游开关 | 用户设置 |
| 图标色调 | `icon_tint` | INTEGER | SIM 图标颜色 | 系统设置 |
| 电话号码 | `display_number` | TEXT | MSISDN | LOADED |
| 网络选择 | `network_selection_mode` | INTEGER | 网络选择模式 | 用户设置 |
| 邮箱 | `mcc_mnc` | TEXT | MCC + MNC | LOADED |
| 邮箱 | `ehplmns` | TEXT | 等效 HPLMN 列表 | LOADED |
| 邮箱 | `hplmns` | TEXT | 归属 PLMN 列表 | LOADED |
| 国家 ISO | `country_iso` | TEXT | 国家代码 | LOADED |
| IMSI | `imsi` | TEXT | 国际移动用户识别码 | LOADED |
| 运营商 ID | `carrier_id` | INTEGER | 运营商数字 ID | LOADED (解析后) |
| 卡片 ID | `card_id` | INTEGER | eSIM 卡片标识 | READY |
| 端口索引 | `port_index` | INTEGER | MEP 端口索引 | READY |
| 是否嵌入 | `is_embedded` | INTEGER | 是否为 eSIM | READY |
| 是否激活 | `is_opportunistic` | INTEGER | 是否为机会主义订阅 | 系统设置 |
| 组 UUID | `group_uuid` | TEXT | 订阅组标识 | 系统设置 |
| 增强运营商 ID | `epo_type` | INTEGER | 运营商配置类型 | 系统设置 |
| 增强运营商 ID | `group_owner` | TEXT | 组拥有者 | 系统设置 |
| 增强运营商 ID | `carrier_privilege_rules` | TEXT | 运营商特权规则 | 系统设置 |
| 配置广播标志 | `config_broadcast_flags` | INTEGER | 配置广播标志位 | 系统设置 |
| 用户管理标志 | `user_handle` | INTEGER | 用户句柄 | 系统设置 |
| D2D 模式 | `device_to_device` | INTEGER | 设备到设备通信模式 | 系统设置 |
| UVia 模式 | `uicc_applications` | INTEGER | UICC 应用类型位掩码 | READY |
| 预加载 | `is_preloaded` | INTEGER | 是否预加载配置 | 系统设置 |
| 组件归属 | `component_name` | TEXT | 配置组件名 | 系统设置 |
| 应用图标 | `app_icon` | BLOB | 应用图标 | 系统设置 |

> 注："填充阶段"一列标注了该字段在 SubscriptionInfo 初始化加载流程中首次被设置的阶段。部分字段（如 `user_handle`、`config_broadcast_flags` 等）由系统服务在后续流程中设置，不在本文讨论的范围内。

---

## 总结

本文详细描述了 Android 开机过程中 SubscriptionInfo 从 `READY` 到 `LOADED` 的初始化加载与数据更新完成流程，核心要点归纳如下：

**两阶段更新模型**：

`updateSubscription()` 在 `READY` 和 `LOADED` 两种状态下各被调用一次。`READY` 阶段建立订阅记录的"骨架"（创建记录、设置基础标识字段），`LOADED` 阶段在骨架基础上填充完整的运营商数据（mccMnc、countryIso、imsi 等）。

**executor + callback 模式**：

`UiccController.updateSimState()` 通过 `executor + callback` 机制调用 `SubscriptionManagerService.updateSimState()`，确保订阅数据库更新完成后才发送 SIM 状态广播，保证了数据一致性。

**全内存缓存架构**：

`SubscriptionDatabaseManager` 采用全内存缓存设计，所有订阅查询直接访问内存，写入操作通过 `ReadWriteLock` 保证线程安全。

**Android 14+ 架构演进**：

旧版 `SubscriptionInfoUpdater`、`SubscriptionUpdatorThread`、`ACTION_INTERNAL_SIM_STATE_CHANGED` 广播驱动模式已被整合到 `SubscriptionManagerService` 中，采用更直接的 executor + callback 模式，降低了组件间的耦合复杂度。

**加载完成通知机制**：

`READY` 和 `LOADED` 状态均会调用 `areAllSubscriptionsLoaded()`（`updateSubscription()` 末尾无条件调用）。`areAllSubscriptionsLoaded()` 的实现不检查运营商信息是否填充，READY 状态本身也不会导致返回 false；它只检查 slot 是否就绪、SIM 状态是否为 UNKNOWN 或 NOT_READY（非最终状态）。READY 与 LOADED 的真正区别在于 `updateSubscription()` 内部：只有 LOADED 才会填充运营商信息，且 UiccController 回调中 READY 被视为非最终状态，不执行运营商 ID 解析和服务更新。`areAllSubscriptionsLoaded()` 返回 true 后通知 `MultiSimSettingController` 启动默认订阅选择和网络连接配置。