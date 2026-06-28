---
title: "Android 开机蜂窝网络请求触发数据激活全流程技术文档"
date: "2026-06-28"
summary: "当 Android 设备开机后，应用或系统服务通过 ConnectivityManager.requestNetwork() 发起蜂窝数据请求。本文档完整追踪该请求从应用进程出发，经 AIDL 跨进程调用到达 ConnectivityService，再通过 NetworkOffer 机制派发回 Telephony 进程中的 TelephonyNetworkProvider，最终由 DataNetworkController 评估并建立数据连接到 modem 的全过程，涵盖 Android 14+ 新架构与旧版 NetworkFactory 的对比。"
category: "data-service"
tags: ["ConnectivityManager", "ConnectivityService", "NetworkOffer", "TelephonyNetworkProvider", "PhoneSwitcher", "DataNetworkController", "DataNetwork", "TelephonyNetworkAgent", "DataServiceManager", "CellularDataService", "requestNetwork", "setupDataCall", "NetworkFactory"]
featured: true
---

## 1 概述

当 Android 设备开机后，应用（或系统服务）需要蜂窝数据连接时，通过 `ConnectivityManager.requestNetwork()` 发起网络请求。这个请求从**应用进程**出发，经过 AIDL 跨进程调用到达**系统服务进程**中的 `ConnectivityService`，再通过 `NetworkOffer` 机制将请求派发回**Telephony 进程**中的 `TelephonyNetworkProvider`，最终由 `DataNetworkController` 评估并建立数据连接到 modem。

整个流程跨越三个进程，涉及的核心组件如下：

```
应用进程                                     系统服务进程                                Telephony 进程
───────────                                  ────────────                              ────────────
ConnectivityManager
  │ requestNetwork
  ▼
IConnectivityManager (AIDL) ──→  ConnectivityService
                                   │ requestNetwork (AIDL)
                                   ▼
                            handleRegisterNetworkRequest
                                   │
                                   ▼
                            rematchNetworksAndRequests
                                   │
                                   ▼
                            issueNetworkNeeds
                                   │
                                   ▼
                            informOffer
                                   │
                                   ▼
                            NetworkOffer.onNetworkNeeded ──→  TelephonyNetworkProvider
                                                                 │ onNetworkNeeded
                                                                 │  ├─→ PhoneSwitcher.onRequestNetwork
                                                                 │  │    (side notification)
                                                                 │  │
                                                                 │  └─→ getPhoneIdForNetworkRequest
                                                                 │       PhoneSwitcher.shouldApplyNetworkRequest
                                                                 │       (consulted for routing decision)
                                                                 ▼
                                                                 DataNetworkController
                                                                   │ addNetworkRequest
                                                                   ▼
                                                                 setupDataNetwork
                                                                   ▼
                                                                 DataNetwork (状态机)
                                                                   ▼
                                                                 DataServiceManager
                                                                   ▼
                                                                 CellularDataService → RIL → Modem
```

### NetworkOffer 新架构

Android 14+ 使用 **NetworkOffer** 机制替代了旧版的 `NetworkFactory`/`NetworkAgent` 架构。核心区别：

| 维度 | 旧版 NetworkFactory | 新版 NetworkOffer |
|------|-------------------|-------------------|
| 注册方式 | `NetworkFactory.register()` | `NetworkProvider.registerNetworkOffer()` |
| 请求派发 | `NetworkFactory.needNetworkFor()` | `NetworkOffer.onNetworkNeeded()` |
| 请求释放 | `NetworkFactory.releaseNetworkFor()` | `NetworkOffer.onNetworkUnneeded()` |
| 能力匹配 | NetworkFactory 自行处理 | ConnectivityService 通过 `informOffer` 统一匹配 |
| 适用场景 | 单一 Transport | 多 Transport 竞争（WiFi vs 蜂窝 vs 卫星） |

## 2 核心类一览

| 类名 | 所属进程 | 职责 | 源码路径 |
|------|---------|------|----------|
| **ConnectivityManager** | 应用 | 应用层网络管理 API 入口 | `Connectivity/framework/src/android/net/ConnectivityManager.java` |
| **IConnectivityManager** | AIDL 接口 | 跨进程通信接口 | `Connectivity/framework/src/android/net/IConnectivityManager.aidl` |
| **ConnectivityService** | 系统服务 | 网络管理核心服务，注册/评估/派发请求 | `Connectivity/service/src/com/android/server/ConnectivityService.java` |
| **NetworkOffer** | 系统服务 | 网络能力报价，管理请求的 needed/unneeded 状态 | `Connectivity/service/src/com/android/server/connectivity/NetworkOffer.java` |
| **TelephonyNetworkProvider** | Telephony | 蜂窝网络提供者，接收 AIDL 回调 | `telephony/.../data/TelephonyNetworkProvider.java` |
| **PhoneSwitcher** | Telephony | 数据电话切换器，将请求路由到目标 Phone | `telephony/.../data/PhoneSwitcher.java` |
| **DataNetworkController** | Telephony | 数据网络控制器，评估并建立/拆除数据网络 | `telephony/.../data/DataNetworkController.java` |
| **DataNetwork** | Telephony | 单个 PDN 状态机，发起 setupDataCall | `telephony/.../data/DataNetwork.java` |
| **TelephonyNetworkAgent** | Telephony | 网络代理，将数据网络注册到 ConnectivityService | `telephony/.../data/TelephonyNetworkAgent.java` |
| **DataServiceManager** | Telephony | DataService 代理，跨进程调用 | `telephony/.../data/DataServiceManager.java` |
| **CellularDataService** | Telephony | DataService Provider，转发到 RIL | `telephony/.../data/CellularDataService.java` |

## 3 ConnectivityManager.requestNetwork 入口

### 3.1 应用发起网络请求

应用通过 `ConnectivityManager.requestNetwork` 请求蜂窝网络。该方法有多个重载，最常用的形式：

```java
// 应用代码
ConnectivityManager cm = getSystemService(ConnectivityManager.class);
NetworkRequest request = new NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
        .build();
cm.requestNetwork(request, networkCallback);
```

### 3.2 ConnectivityManager 内部处理

`ConnectivityManager.requestNetwork` 的核心逻辑在 `sendRequestForNetwork` 方法中：

1. 创建 `Messenger` 和 `Binder` 用于回调通信
2. 通过 `mService.requestNetwork(...)` 发起 AIDL 跨进程调用到 `ConnectivityService`
3. 返回的 `NetworkRequest` 对象缓存到 `sCallbacks` Map 中

```java
// ConnectivityManager.java
private NetworkRequest sendRequestForNetwork(int asUid, NetworkCapabilities need,
        NetworkCallback callback, int timeoutMs, NetworkRequest.Type reqType,
        int legacyType, CallbackHandler handler) {
    // 创建 Messenger 和 Binder
    // 调用 mService.requestNetwork(asUid, need, reqType, messenger, ...)
    // 缓存 NetworkRequest 到 sCallbacks
}
```

### 3.3 AIDL 跨进程调用

`mService` 是 `IConnectivityManager` 接口的代理对象，通过 AIDL 调用到系统服务进程中的 `ConnectivityService`：

```java
// IConnectivityManager.aidl
NetworkRequest requestNetwork(int uid, in NetworkCapabilities networkCapabilities,
        int reqType, in Messenger messenger, int timeoutSec, in IBinder binder,
        int legacy, int callbackFlags, String callingPackageName,
        String callingAttributionTag, int declaredMethodsFlag);
```

## 4 ConnectivityService 处理网络请求

### 4.1 ConnectivityService.requestNetwork 入口

`ConnectivityService.requestNetwork` 是 AIDL 接口的实现方法，处理从应用进程发来的网络请求。

核心流程：

1. 解析请求类型（`TRACK_DEFAULT` / `REQUEST` / `BACKGROUND_REQUEST` 等）
2. 权限检查（`ENFORCE_NETWORK_PERMISSION`）
3. 创建 `NetworkRequest` 对象和 `NetworkRequestInfo`（NRI）封装
4. 调用 `trackUidAndRegisterNetworkRequest(EVENT_REGISTER_NETWORK_REQUEST, nri)`

```java
// ConnectivityService.java
public NetworkRequest requestNetwork(int asUid, NetworkCapabilities networkCapabilities,
        int reqTypeInt, Messenger messenger, ...) {
    // 解析请求类型
    // 权限检查
    NetworkRequest request = new NetworkRequest(networkCapabilities, legacyType, reqType);
    NetworkRequestInfo nri = new NetworkRequestInfo(...);
    trackUidAndRegisterNetworkRequest(EVENT_REGISTER_NETWORK_REQUEST, nri);
    return request;
}
```

### 4.2 Handler 串行处理

`trackUidAndRegisterNetworkRequest` 通过 `InternalHandler` 发送 `EVENT_REGISTER_NETWORK_REQUEST` 消息，确保在 ConnectivityService 的 Handler 线程中串行处理：

```java
// ConnectivityService.java
private void trackUidAndRegisterNetworkRequest(final int event, NetworkRequestInfo nri) {
    // 追踪 UID 的 blocked 状态
    mHandler.obtainMessage(event, nri).sendToTarget();
}
```

`InternalHandler` 收到消息后调用 `handleRegisterNetworkRequest`。

### 4.3 handleRegisterNetworkRequest

```java
// ConnectivityService.java
private void handleRegisterNetworkRequest(@NonNull final NetworkRequestInfo nri) {
    handleRegisterNetworkRequests(Collections.singleton(nri));
}

private void handleRegisterNetworkRequests(
        @NonNull final Set<NetworkRequestInfo> nris) {
    // 将请求加入 mNetworkRequests 映射
    // 更新 satisfier
    rematchNetworksAndRequests(nris);   // 触发网络重匹配
}
```

### 4.4 rematchNetworksAndRequests — 网络重匹配

这是 `ConnectivityService` 的核心调度方法，负责将网络请求与可用的网络提供者进行匹配：

```java
// ConnectivityService.java
private void rematchNetworksAndRequests(
        @NonNull final Set<NetworkRequestInfo> networkRequests) {
    final NetworkReassignment changes = computeNetworkReassignment(networkRequests);
    applyNetworkReassignment(changes, start);
    issueNetworkNeeds();
}
```

三步执行：
1. **computeNetworkReassignment** — 计算最优的网络分配方案
2. **applyNetworkReassignment** — 应用分配结果，更新 satisfier，处理默认网络变更
3. **issueNetworkNeeds** — 将未满足的请求派发给 NetworkProvider

## 5 NetworkOffer 机制与请求派发

### 5.1 issueNetworkNeeds

`issueNetworkNeeds` 遍历所有已注册的 `NetworkOfferInfo`，对每个 offer 调用 `informOffer` 评估：

```java
// ConnectivityService.java
private void issueNetworkNeeds() {
    for (final NetworkOfferInfo noi : mNetworkOffers) {
        for (final NetworkRequestInfo nri : mNetworkRequests.values()) {
            if (nri.isRequest()) {   // 只处理 REQUEST 类型，不处理 LISTEN
                informOffer(nri, noi.offer, mNetworkRanker);
            }
        }
    }
}
```

### 5.2 informOffer — 三阶段匹配逻辑

`informOffer` 对每个网络请求和每个网络报价进行三阶段评估：

```
第一阶段（行 13398-13410）：高于当前 satisfier 的请求
  → 如果 offer 能满足 → offer.onNetworkNeeded(request)

第二阶段（行 13412-13430）：当前 satisfier 层级的请求
  → 使用 NetworkRanker.mightBeat() 判断 offer 能否胜出
    → 能胜出 → onNetworkNeeded(request)
    → 不能胜出 → onNetworkUnneeded(request)

第三阶段（行 13432-13443）：低于当前 satisfier 的请求
  → offer.onNetworkUnneeded(request)
```

`NetworkRanker.mightBeat()` 是竞争决策的核心，比较当前 satisfier 网络和候选 offer 网络的分数，决定是否切换。

### 5.3 NetworkOffer.onNetworkNeeded — AIDL 回调

```java
// NetworkOffer.java
public void onNetworkNeeded(@NonNull final NetworkRequest request) {
    mCurrentlyNeeded.add(request);
    if (mCallback != null) {
        mCallback.onNetworkNeeded(request);  // AIDL 调用到 NetworkProvider
    }
}

public void onNetworkUnneeded(@NonNull final NetworkRequest request) {
    mCurrentlyNeeded.remove(request);
    if (mCallback != null) {
        mCallback.onNetworkUnneeded(request);  // AIDL 调用到 NetworkProvider
    }
}
```

`mCallback` 是 `INetworkOfferCallback` 接口，在 `registerNetworkOffer` 时由 ConnectivityService 传入。通过 AIDL 回调到 Telephony 进程中的 `TelephonyNetworkProvider`。

## 6 TelephonyNetworkProvider 接收请求

### 6.1 TelephonyNetworkProvider 构造与注册

`TelephonyNetworkProvider` 继承 `NetworkProvider`，在构造函数中注册自身并声明可提供的网络能力：

```java
// TelephonyNetworkProvider.java 构造函数
ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
cm.registerNetworkProvider(this);
NetworkCapabilities caps = makeNetworkFilter();
registerNetworkOffer(new NetworkScore.Builder().build(), caps, mHandler::post, this);
```

`makeNetworkFilter` 返回的 `NetworkCapabilities` 包含：
- `TRANSPORT_CELLULAR` / `TRANSPORT_SATELLITE`
- `NET_CAPABILITY_IA` / `NET_CAPABILITY_MMTEL` / `NET_CAPABILITY_NOT_RESTRICTED`
- `NET_ENTERPRISE_ID_1` 到 `NET_ENTERPRISE_ID_5`
- `MatchAllNetworkSpecifier`（匹配所有 NetworkSpecifier）

同时注册了两个监听器：
- `SubscriptionManager.OnSubscriptionsChangedListener` — SIM 卡变更时重新评估请求
- `PhoneSwitcherCallback` — DDS 变更时重新评估并迁移请求

### 6.2 onNetworkNeeded — 请求入口

```java
// TelephonyNetworkProvider.java
public void onNetworkNeeded(@NonNull NetworkRequest request) {
    TelephonyNetworkRequest networkRequest = new TelephonyNetworkRequest(request, mFlags);
    if (mNetworkRequests.containsKey(networkRequest)) return;  // 去重

    mPhoneSwitcher.onRequestNetwork(networkRequest);    // 旁路通知 PhoneSwitcher

    int phoneId = getPhoneIdForNetworkRequest(networkRequest);  // 查询目标 Phone
    if (phoneId != SubscriptionManager.INVALID_PHONE_INDEX) {
        PhoneFactory.getPhone(phoneId).getDataNetworkController()
                .addNetworkRequest(networkRequest);
    }

    mNetworkRequests.put(networkRequest, phoneId);
}
```

注意：`mPhoneSwitcher.onRequestNetwork(networkRequest)` 是一个**旁路通知**。它将请求加入 PhoneSwitcher 内部列表并触发 `onEvaluate`，但**并不决定路由目标**。请求本身从 `TelephonyNetworkProvider` 直接流向 `DataNetworkController`，不经过 PhoneSwitcher。

### 6.3 路由决策 — PhoneSwitcher.shouldApplyNetworkRequest

`getPhoneIdForNetworkRequest` 遍历所有 Phone，调用 `PhoneSwitcher.shouldApplyNetworkRequest` 判断请求应该由哪个 Phone 处理：

```java
// TelephonyNetworkProvider.java
private int getPhoneIdForNetworkRequest(@NonNull TelephonyNetworkRequest request) {
    for (Phone phone : PhoneFactory.getPhones()) {
        int phoneId = phone.getPhoneId();
        if (mPhoneSwitcher.shouldApplyNetworkRequest(request, phoneId)) {
            return phoneId;  // 返回第一个匹配的 Phone
        }
    }
    return SubscriptionManager.INVALID_PHONE_INDEX;
}
```

`PhoneSwitcher.shouldApplyNetworkRequest` 的决策逻辑：
- 如果 Phone 状态为 inactive 且不是紧急请求，返回 false
- 如果请求指定了 subId（通过 `TelephonyNetworkSpecifier`），检查是否匹配该 Phone 的 subId
- 如果请求需要 INTERNET 且未指定 subId，仅当该 Phone 是 `mPreferredDataPhoneId`（DDS 所在 Phone）时返回 true
- 如果请求是 restricted（如 SUPL），根据语音通话状态等条件判断
- DSDS 设备上，非默认 DDS 的 Phone 对默认 Internet 请求返回 false

### 6.4 onNetworkUnneeded — 请求移除

```java
// TelephonyNetworkProvider.java
public void onNetworkUnneeded(@NonNull NetworkRequest request) {
    mPhoneSwitcher.onReleaseNetwork(networkRequest);
    int phoneId = mNetworkRequests.remove(networkRequest);
    Phone phone = PhoneFactory.getPhone(phoneId);
    if (phone != null) {
        phone.getDataNetworkController().removeNetworkRequest(networkRequest);
    }
}
```

注意：`onNetworkUnneeded` 不会直接拆除数据网络。实际的网络拆除依赖 `TelephonyNetworkAgent.onNetworkUnwanted()` 回调。

### 6.5 reevaluateNetworkRequests — DDS 切换时迁移请求

当默认数据订阅变更时，`TelephonyNetworkProvider` 重新评估所有现有请求的路由目标，将请求从旧 Phone 迁移到新 Phone：

```java
// TelephonyNetworkProvider.java
private void reevaluateNetworkRequests(@NonNull String reason) {
    mNetworkRequests.forEach((request, oldPhoneId) -> {
        int newPhoneId = getPhoneIdForNetworkRequest(request);
        if (newPhoneId != oldPhoneId) {
            if (oldPhoneId != INVALID_PHONE_INDEX) {
                PhoneFactory.getPhone(oldPhoneId).getDataNetworkController()
                        .removeNetworkRequest(request);
            }
            if (newPhoneId != INVALID_PHONE_INDEX) {
                PhoneFactory.getPhone(newPhoneId).getDataNetworkController()
                        .addNetworkRequest(request);
            }
            mNetworkRequests.put(request, newPhoneId);
        }
    });
}
```

## 7 DataNetworkController 建立数据网络

### 7.1 addNetworkRequest 入口

`DataNetworkController.addNetworkRequest` 收到来自 `TelephonyNetworkProvider` 的网络请求后，发送 `EVENT_ADD_NETWORK_REQUEST` Handler 消息：

```java
// DataNetworkController.java
public void addNetworkRequest(@NonNull TelephonyNetworkRequest networkRequest) {
    sendMessage(obtainMessage(EVENT_ADD_NETWORK_REQUEST, networkRequest));
}
```

Handler 处理后调用 `onAddNetworkRequest`，将请求加入 `mAllNetworkRequestList`，然后发送 `EVENT_REEVALUATE_UNSATISFIED_NETWORK_REQUESTS` 触发评估。

### 7.2 评估网络请求

`onReevaluateUnsatisfiedNetworkRequests` 的执行逻辑：

1. 通过 `getGroupedUnsatisfiedNetworkRequests()` 收集所有处于 `REQUEST_STATE_UNSATISFIED` 状态的网络请求，按网络能力分组
2. 对每组请求，先尝试由已有的 DataNetwork 满足
3. 对无法满足的请求，调用评估逻辑 `evaluateDataNetworkRequest`
4. 评估通过（无 disallowed 原因）→ `setupDataNetwork`

评估中检查的关键条件包括：
- `DATA_DISABLED`：数据是否被关闭
- `DATA_SETTINGS_NOT_READY`：数据设置是否初始化
- `ROAMING_DISABLED`：漫游是否被禁止
- `RAT_NOT_ALLOWED`：当前 RAT 是否允许
- `NO_SUITABLE_DATA_PROFILE`：是否有合适的数据配置
- `DATA_THROTTLED`：是否被限流

### 7.3 setupDataNetwork 创建 DataNetwork

评估通过后，创建新的 `DataNetwork` 实例：

```java
// DataNetworkController.java
private void setupDataNetwork(@NonNull DataProfile dataProfile,
        @Nullable DataSetupRetryEntry dataSetupRetryEntry,
        @NonNull DataAllowedReason allowedReason) {
    NetworkRequestList networkRequestList = findSatisfiableNetworkRequests(dataProfile);
    int transport = mAccessNetworksManager
            .getPreferredTransportByNetworkCapability(...);
    mDataNetworkList.add(new DataNetwork(mPhone, mFeatureFlags, getLooper(),
            mDataServiceManagers, dataProfile, networkRequestList, transport, ...));
}
```

新创建的 `DataNetwork` 初始状态为 `ConnectingState`，在 `enter()` 中发起 `DataServiceManager.setupDataCall()`。

### 7.4 setupDataCall 到 Modem

```
DataNetwork.ConnectingState.enter()
  → DataServiceManager.setupDataCall(accessNetwork, dataProfile, ...)
    → CellularDataService.setupDataCall(...)
      → RIL.setupDataCall(...)
        → RadioDataProxy.setupDataCall(...)
          → IRadioData.setupDataCall        // HAL → Modem
```

modem 返回 `SetupDataCallResponse` 后，`DataNetwork` 从 `ConnectingState` 转入 `ConnectedState`。

## 8 TelephonyNetworkAgent 注册网络

### 8.1 NetworkAgent 的创建

`DataNetwork` 进入 `ConnectedState` 后，创建 `TelephonyNetworkAgent` 并注册到 `ConnectivityService`。`TelephonyNetworkAgent` 继承 `NetworkAgent`，代表一个已建立的数据网络。

```java
// TelephonyNetworkAgent
TelephonyNetworkAgent(Context context, ...) {
    super(context, looper, ...) {
        // 提供 NetworkCapabilities 和 LinkProperties
    }
    register();
}
```

### 8.2 网络可用通知

`TelephonyNetworkAgent` 注册到 `ConnectivityService` 后，ConnectivityService 通过 `applyNetworkReassignment` 更新 satisfier，将已满足的网络请求与此 `NetworkAgent` 关联。随后通过 `NetworkCallback.onAvailable()` 回调通知应用网络已可用。

### 8.3 网络拆除

当所有关联的 NetworkRequest 都被移除后，ConnectivityService 调用 `TelephonyNetworkAgent.onNetworkUnwanted()`。`TelephonyNetworkAgent` 通知 `DataNetworkController` 拆除对应的数据网络：

```
ConnectivityService.onNetworkUnwanted()
  → TelephonyNetworkAgent.onNetworkUnwanted()
    → DataNetworkController.tearDownAllDataNetworks(CONNECTIVITY_SERVICE_UNWANTED)
      → DataNetwork.tearDown
        → DataServiceManager.deactivateDataCall
          → CellularDataService → RIL → Modem
```

## 9 完整调用链汇总

### 网络请求触发数据激活（从应用到 Modem）

| 步骤 | 类 | 方法 | 关键动作 |
|------|-----|------|----------|
| 1 | ConnectivityManager | requestNetwork | 创建 NetworkRequest 和回调 |
| 2 | IConnectivityManager | requestNetwork (AIDL) | 跨进程调用到系统服务 |
| 3 | ConnectivityService | requestNetwork | 解析类型、权限检查、创建 NRI |
| 4 | ConnectivityService | handleRegisterNetworkRequest | 将请求加入 mNetworkRequests |
| 5 | ConnectivityService | rematchNetworksAndRequests | 计算网络分配方案 |
| 6 | ConnectivityService | issueNetworkNeeds → informOffer | 三阶段匹配评估 |
| 7 | NetworkOffer | onNetworkNeeded | 加入 needed 集合 |
| 8 | INetworkOfferCallback | onNetworkNeeded (AIDL) | 跨进程回调到 Telephony |
| 9 | TelephonyNetworkProvider | onNetworkNeeded | 封装为 TelephonyNetworkRequest |
| 10 | PhoneSwitcher | onRequestNetwork | 旁路通知 PhoneSwitcher（不决定路由） |
| 11 | TelephonyNetworkProvider | getPhoneIdForNetworkRequest | 调用 PhoneSwitcher.shouldApplyNetworkRequest 获取目标 Phone |
| 12 | DataNetworkController | addNetworkRequest | 将请求加入评估队列 |
| 13 | DataNetworkController | onReevaluateUnsatisfiedNetworkRequests | 评估未满足的请求 |
| 14 | DataNetworkController | evaluateDataNetworkRequest | 检查数据启用、漫游、RAT 等 |
| 15 | DataNetworkController | setupDataNetwork | 创建 DataNetwork 实例 |
| 16 | DataNetwork | ConnectingState.enter | 发起 setupDataCall |
| 17 | DataServiceManager | setupDataCall | 跨进程调用 DataService |
| 18 | CellularDataService | setupDataCall | 转发到 RIL 接口 |
| 19 | RIL | setupDataCall | 创建 RIL 请求 |
| 20 | RadioDataProxy | setupDataCall | HAL 调用 modem |

### 网络请求移除（从应用到 Modem）

| 步骤 | 类 | 方法 | 关键动作 |
|------|-----|------|----------|
| 1 | ConnectivityManager | unregisterNetworkCallback | 发起请求移除 |
| 2 | ConnectivityService | handleReleaseNetworkRequest | 从 mNetworkRequests 移除 |
| 3 | ConnectivityService | rematchNetworksAndRequests | 重新匹配 |
| 4 | NetworkOffer | onNetworkUnneeded | 从 needed 集合移除 |
| 5 | TelephonyNetworkProvider | onNetworkUnneeded | 从 DataNetworkController 移除请求 |
| 6 | ConnectivityService | onNetworkUnwanted | 所有请求移除后通知 |
| 7 | TelephonyNetworkAgent | onNetworkUnwanted | 触发数据网络拆除 |
| 8 | DataNetworkController | tearDownAllDataNetworks | 拆除数据网络 |
| 9 | DataNetwork | tearDown → deactivateDataCall | modem 释放数据连接 |
