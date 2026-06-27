---
title: "Android 开机数据网络建立全流程分析"
date: "2025-06-26"
summary: "从 SIM 卡加载完成到数据链路完全就绪的完整流程分析，涵盖 DataProfile 设置、DataNetworkController 网络请求评估、数据业务激活（RIL_REQUEST_SETUP_DATA_CALL）以及链路信息更新四大阶段。"
category: "data-service"
tags: ["DataProfileManager", "DataNetworkController", "DataNetwork", "APN", "RIL", "PDN", "ConnectivityService", "TelephonyNetworkAgent", "DataServiceManager", "CellularDataService"]
featured: true
---

> **文档定位**：基于 AOSP 源码，从 SIM 卡加载完成到数据链路完全就绪的完整流程分析

## 第 1 章：概述

### 1.1 开机数据网络建立是什么

开机数据网络建立是指 Android 设备插入 SIM 卡并开机后，从 SIM 卡加载完成到数据链路完全就绪的完整过程。这是蜂窝数据业务的基础流程，确保用户能够通过蜂窝网络访问互联网、进行语音通话（IMS）、发送短信等。

整个流程可以概括为四个核心阶段：

1. **DataProfile 设置就绪**：读取 SIM 卡中的 APN 配置，构建 DataProfile 列表，同步到 Modem
2. **网络请求评估**：DataNetworkController 根据系统网络请求，评估并决定需要建立哪些数据网络
3. **数据业务激活**：创建 DataNetwork 对象，向 Modem 发送 `RIL_REQUEST_SETUP_DATA_CALL` 请求
4. **链路信息更新**：Modem 上报数据连接状态变化，Framework 更新链路属性并通知 ConnectivityService

### 1.2 为什么需要分阶段

数据网络建立需要分阶段完成，主要原因：

- **配置先行**：APN 配置是数据连接的基础，必须先将 DataProfile 发送给 Modem，Modem 才能正确建立 PDN 连接
- **请求驱动**：数据连接是按需建立的，只有当系统或应用发起网络请求时才需要建立对应的数据网络
- **状态同步**：Modem 和 Framework 需要保持状态同步，通过 `RIL_UNSOL_DATA_CALL_LIST_CHANGED` 上报机制确保链路信息的实时更新

### 1.3 整体流程总览

```
开机 → SIM 卡加载完成
  ↓
DataProfile 设置就绪
  ├── DataProfileManager.updateDataProfiles()
  ├── 读取 APN 数据库 → 创建 DataProfile 列表
  ├── 设置 preferredDataProfile / IA DataProfile
  ├── RIL_REQUEST_SET_DATA_PROFILE → Modem
  ├── RIL_REQUEST_SET_INITIAL_ATTACH_APN → Modem
  └── 通知 onDataProfilesChanged()

  ↓
网络注册完成（ServiceState 变化）
  ↓
DataNetworkController 评估网络建立
  ├── shouldReevaluateNetworkRequests() 判断
  ├── 网络请求分组（getGroupedUnsatisfiedNetworkRequests）
  ├── 选择 DataProfile（getDataProfileForNetworkRequest）
  └── 创建 DataNetwork 对象

  ↓
激活数据业务
  ├── DataNetwork.setupData()
  ├── DataServiceManager.setupDataCall()
  ├── CellularDataService.setupDataCall()
  ├── RIL_REQUEST_SETUP_DATA_CALL → Modem
  ├── Modem 返回 DataCallResponse
  ├── 创建 TelephonyNetworkAgent
  └── 进入 Connected 状态

  ↓
更新数据链路信息
  ├── RIL_UNSOL_DATA_CALL_LIST_CHANGED（Modem 上报）
  ├── DataNetwork.onDataStateChanged()
  ├── updateDataNetwork() 更新 LinkProperties
  ├── updateNetworkCapabilities() 更新能力
  └── TelephonyNetworkAgent 通知 ConnectivityService
```

---

## 第 2 章：核心类与数据结构

### 2.1 DataProfileManager：DataProfile 管理器

**文件**：DataProfileManager.java

`DataProfileManager` 负责管理所有 `DataProfile`，是 APN 配置的核心管理者：

- **读取 APN 数据库**：从 `Telephony.Carriers.SIM_APN_URI` 读取运营商配置的 APN
- **构建 DataProfile 列表**：将每个 APN 转换为 `DataProfile`（包含 `ApnSetting` 和 `TrafficDescriptor`）
- **补充默认配置**：当缺少 IMS/EIMS/Enterprise APN 时，添加默认配置
- **设置 preferred DataProfile**：从数据库或配置中读取用户/系统首选的 APN
- **设置 IA DataProfile**：选择用于初始附着的 APN，同步到 Modem
- **同步到 Modem**：通过 `updateDataProfilesAtModem()` 和 `updateInitialAttachDataProfileAtModem()` 将配置下发

### 2.2 DataServiceManager / CellularDataService：数据服务桥接层

**文件**：
- DataServiceManager.java
- CellularDataService.java

`DataServiceManager` 管理与 `CellularDataService` 的 Binder 连接，提供统一的接口转发数据服务请求：

- `setDataProfile()`：设置 DataProfile 列表
- `setInitialAttachApn()`：设置初始附着 APN
- `setupDataCall()`：建立数据连接
- `deactivateDataCall()`：断开数据连接

`CellularDataService` 实现 `IDataService` 接口，将请求转换为 RIL 请求下发给 Modem。

### 2.3 DataNetworkController：网络请求评估与协调中心

**文件**：DataNetworkController.java

`DataNetworkController` 是数据网络的核心控制器，负责：

- **评估网络请求**：根据 ServiceState 变化和网络请求，决定是否需要建立/断开数据网络
- **分组网络请求**：将相似的网络请求分组，共享同一个 DataNetwork
- **选择 DataProfile**：根据网络请求的能力要求，选择合适的 DataProfile
- **创建/管理 DataNetwork**：创建 `DataNetwork` 对象，管理其生命周期
- **协调数据连接**：处理数据网络的连接、断开、切换等事件

### 2.4 DataNetwork：单 PDN 连接抽象

**文件**：DataNetwork.java

`DataNetwork` 代表单个 PDN（Packet Data Network）连接，是数据业务的基本单元：

- **状态机管理**：管理连接状态（Idle → SettingUp → Connected → Disconnecting → Disconnected）
- **数据业务激活**：调用 `setupData()` 发起数据连接请求
- **响应处理**：处理 Modem 返回的 `DataCallResponse`，解析链路信息
- **链路信息更新**：更新 `LinkProperties`（接口名、地址、DNS、MTU 等）
- **NetworkAgent 管理**：创建和管理 `TelephonyNetworkAgent`，向 ConnectivityService 上报网络信息

### 2.5 TelephonyNetworkAgent：网络信息上报代理

**文件**：TelephonyNetworkAgent.java

`TelephonyNetworkAgent` 继承自 `NetworkAgent`，是 Telephony 模块与 ConnectivityService 通信的桥梁：

- **注册网络**：调用父类 `register()` 方法向 ConnectivityService 注册网络
- **上报链路属性**：通过 `sendLinkProperties()` 上报接口名、地址、DNS 等信息
- **上报网络能力**：通过 `sendNetworkCapabilities()` 上报网络支持的能力（如 INTERNET、IMS 等）
- **状态通知**：通知网络连接状态、验证状态等变化

### 2.6 核心数据结构

#### 2.6.1 DataProfile

`DataProfile` 是数据配置文件的抽象，包含：

- **ApnSetting**：APN 设置信息（APN 名称、协议、APN 类型、用户名/密码等）
- **TrafficDescriptor**：流量描述符（DNN、OS App ID、连接能力等，5G 特性）
- **preferred**：是否为用户首选 APN
- **lastSetupTimestamp**：上次成功建立连接的时间戳

#### 2.6.2 ApnSetting

`ApnSetting` 定义了单个 APN 的配置：

- **entryName**：APN 显示名称
- **apnName**：APN 名称（如 "cmnet"、"3gnet"）
- **protocol**：协议（IPv4、IPv6、IPv4v6）
- **apnTypeBitmask**：APN 类型掩码（TYPE_DEFAULT、TYPE_IMS、TYPE_MMS 等）
- **carrierEnabled**：运营商是否启用
- **mtuV4/mtuV6**：MTU 值

#### 2.6.3 TrafficDescriptor

`TrafficDescriptor` 是 5G 网络引入的流量描述符：

- **dataNetworkName**：DNN（Data Network Name），对应传统 APN 名称
- **osAppId**：OS App ID，用于区分不同应用的流量
- **connectionCapability**：连接能力

#### 2.6.4 DataCallResponse

`DataCallResponse` 是 Modem 返回的数据呼叫响应：

- **id**：CID（Call ID），数据呼叫的唯一标识
- **interfaceName**：网络接口名称（如 "rmnet0"）
- **addresses**：链路地址列表（IPv4/IPv6）
- **dnsAddresses**：DNS 服务器地址列表
- **mtuV4/mtuV6**：MTU 值
- **pcscfAddresses**：PCSCF 服务器地址（IMS 专用）
- **linkStatus**：链路状态（ACTIVE/INACTIVE）
- **cause**：失败原因码

---

## 第 3 章：RIL 消息交互

### 3.1 RIL_REQUEST_SET_DATA_PROFILE：设置 DataProfile 列表

**下发位置**：RIL.setDataProfile()

```java
public void setDataProfile(DataProfile[] profiles, Message result) {
    // ...
    RILRequest rr = obtainRequest(RIL_REQUEST_SET_DATA_PROFILE, result, mRILDefaultWorkSource);
    // 通过 HAL 下发请求
}
```

**调用链路**：
```
DataProfileManager.updateDataProfilesAtModem()
  → DataServiceManager.setDataProfile()
  → CellularDataService.setDataProfile()
  → mPhone.mCi.setDataProfile()
  → RIL.setDataProfile()
  → RIL_REQUEST_SET_DATA_PROFILE → Modem
```

**用途**：将 Framework 侧的 DataProfile 列表同步到 Modem，Modem 根据这些配置建立 PDN 连接。

### 3.2 RIL_REQUEST_SET_INITIAL_ATTACH_APN：设置初始附着 APN

**下发位置**：RIL.setInitialAttachApn()

```java
public void setInitialAttachApn(DataProfile dp, Message result) {
    // ...
    RILRequest rr = obtainRequest(RIL_REQUEST_SET_INITIAL_ATTACH_APN, result,
            mRILDefaultWorkSource);
    // 通过 HAL 下发请求
}
```

**调用链路**：
```
DataProfileManager.updateInitialAttachDataProfileAtModem()
  → DataServiceManager.setInitialAttachApn()
  → CellularDataService.setInitialAttachApn()
  → mPhone.mCi.setInitialAttachApn()
  → RIL.setInitialAttachApn()
  → RIL_REQUEST_SET_INITIAL_ATTACH_APN → Modem
```

**用途**：设置用于网络初始附着的 APN。某些网络在附着阶段就需要知道使用哪个 APN。

### 3.3 RIL_REQUEST_SETUP_DATA_CALL：激活数据业务

**下发位置**：RIL.setupDataCall()

```java
public void setupDataCall(int accessNetworkType, DataProfile dataProfile,
        boolean allowRoaming, int reason, LinkProperties linkProperties,
        int pduSessionId, NetworkSliceInfo sliceInfo,
        TrafficDescriptor trafficDescriptor, boolean matchAllRuleAllowed, Message result) {
    // ...
    RILRequest rr = obtainRequest(RIL_REQUEST_SETUP_DATA_CALL, result, mRILDefaultWorkSource);
    // 通过 HAL 下发请求
}
```

**调用链路**：
```
DataNetwork.setupData()
  → DataServiceManager.setupDataCall()
  → CellularDataService.setupDataCall()
  → mPhone.mCi.setupDataCall()
  → RIL.setupDataCall()
  → RIL_REQUEST_SETUP_DATA_CALL → Modem
```

**用途**：向 Modem 请求建立 PDN 连接。Modem 完成后返回 `DataCallResponse`，包含接口名、地址、DNS 等信息。

### 3.4 RIL_UNSOL_DATA_CALL_LIST_CHANGED：数据呼叫列表变化上报

**接收位置**：DataIndication.dataCallListChanged()

```java
public void dataCallListChanged(List<DataCallResponse> dcList) {
    if (mRil.isLogOrTrace()) mRil.unsljLogRet(RIL_UNSOL_DATA_CALL_LIST_CHANGED, dcList);
    mRil.processIndication(HAL_SERVICE_DATA, 0);
    mRil.getServiceStateTracker().notifyDataCallListChanged(dcList);
}
```

**处理链路**：
```
Modem 上报 RIL_UNSOL_DATA_CALL_LIST_CHANGED
  → DataIndication.dataCallListChanged()
  → ServiceStateTracker.notifyDataCallListChanged()
  → DataNetworkController 通知各 DataNetwork
  → DataNetwork.onDataStateChanged()
```

**用途**：Modem 主动上报数据呼叫列表的变化，包括新建立的连接、断开的连接、状态变化等。Framework 通过此消息保持与 Modem 的状态同步。

---

## 第 4 章：DataProfile 设置就绪

### 4.1 SIM 卡加载完成触发

当 SIM 卡状态变为 `IccCardConstants.State.LOADED` 时，`DataProfileManager` 会收到通知并触发 `updateDataProfiles()`。

**触发位置**：DataProfileManager 构造函数注册监听

```java
// 监听 SIM 卡状态变化
mPhone.getIccCard().registerForLockedOrLoaded(this, EVENT_ICC_CARD_LOADED_OR_LOCKED, null);

// 监听运营商配置更新
mDataConfigManager.registerForConfigChanged(this, EVENT_CARRIER_CONFIG_UPDATED, null);

// 监听数据网络连接状态
mDataNetworkController.registerForDataNetworkConnected(this,
        EVENT_DATA_NETWORK_CONNECTED, null);
```

### 4.2 updateDataProfiles() 流程

**位置**：DataProfileManager.updateDataProfiles()

#### 4.2.1 读取 APN 数据库

```java
Cursor cursor = mPhone.getContext().getContentResolver().query(
        Uri.withAppendedPath(Telephony.Carriers.SIM_APN_URI, "filtered/subId/"
                + mPhone.getSubId()), null, null, null, Telephony.Carriers._ID);
```

`SIM_APN_URI` 返回的是运营商特定的 APN 配置，这些配置来自 SIM 卡的 EF_PNN/EF_WPS 文件或运营商配置包。

#### 4.2.2 创建 DataProfile

```java
while (cursor.moveToNext()) {
    ApnSetting apn = ApnSetting.makeApnSetting(cursor);
    if (apn != null) {
        DataProfile dataProfile = new DataProfile.Builder()
                .setApnSetting(apn)
                .setTrafficDescriptor(new TrafficDescriptor(apn.getApnName(), null))
                .setPreferred(false)
                .build();
        profiles.add(dataProfile);
    }
}
```

每个 APN 记录会被转换为一个 `DataProfile`，包含 `ApnSetting` 和基于 APN 名称构建的 `TrafficDescriptor`。

#### 4.2.3 补充默认配置

系统会检查是否缺少关键的 APN 类型，如果缺少则添加默认配置：

| APN 类型 | 默认配置 | 条件 |
|---------|---------|------|
| IMS | `apn=ims, type=IMS` | SIM 已加载且无 IMS APN |
| EIMS | `apn=sos, type=EMERGENCY` | 无 EIMS APN |
| Enterprise | DPC 配置 | 无 Enterprise APN |

#### 4.2.4 去重与检查

```java
dedupeDataProfiles(profiles);  // 去除重复的 DataProfile
checkDataProfiles(profiles);   // 检查 APN 配置异常
```

### 4.3 preferredDataProfile 设置

**位置**：DataProfileManager.updatePreferredDataProfile()

系统按以下优先级选择 preferred DataProfile：

1. **从数据库读取**：用户之前设置的首选 APN（存储在 `Telephony.Carriers` 表中）
2. **从配置读取**：运营商配置中指定的默认 APN（`DEFAULT_PREFERRED_APN`）
3. **缓存的上次成功 APN**：`mLastInternetDataProfiles` 中缓存的上次成功建立连接的 Internet APN

### 4.4 同步到 Modem

#### 4.4.1 更新 DataProfile 列表

**位置**：DataProfileManager.updateDataProfilesAtModem()

```java
private void updateDataProfilesAtModem() {
    log("updateDataProfilesAtModem: set " + mAllDataProfiles.size() + " data profiles.");
    mWwanDataServiceManager.setDataProfile(mAllDataProfiles,
            mPhone.getServiceState().getDataRoamingFromRegistration(), null);
}
```

#### 4.4.2 更新初始附着 APN

**位置**：DataProfileManager.updateInitialAttachDataProfileAtModem()

```java
private void updateInitialAttachDataProfileAtModem(boolean forceUpdateIa) {
    // 按优先级排序（preferred 优先）
    List<DataProfile> allDataProfiles = mAllDataProfiles.stream()
            .sorted(Comparator.comparing((DataProfile dp) -> !dp.equals(mPreferredDataProfile)))
            .toList();
    
    // 按允许的初始附着 APN 类型查找
    for (int apnType : mDataConfigManager.getAllowedInitialAttachApnTypes()) {
        initialAttachDataProfile = allDataProfiles.stream()
                .filter(dp -> dp.canSatisfy(DataUtils.apnTypeToNetworkCapability(apnType)))
                .findFirst()
                .orElse(null);
        if (initialAttachDataProfile != null) break;
    }
    
    // 发送到 Modem
    mWwanDataServiceManager.setInitialAttachApn(mInitialAttachDataProfile, ...);
}
```

### 4.5 通知回调

当 DataProfile 列表变化时，通知所有注册的回调：

```java
mDataProfileManagerCallbacks.forEach(callback -> callback.invokeFromExecutor(
        callback::onDataProfilesChanged));
```

---

## 第 5 章：DataNetworkController 评估网络建立

### 5.1 触发时机：ServiceState 变化

**位置**：DataNetworkController 监听 ServiceState 变化

当网络注册状态变化时（如从 `OUT_OF_SERVICE` 变为 `IN_SERVICE`），会触发网络请求重评估：

```java
if (shouldReevaluateNetworkRequests(mServiceState, newServiceState, transport)) {
    evaluateNetworkRequests = true;
}
```

### 5.2 shouldReevaluateNetworkRequests() 判断逻辑

判断是否需要重评估网络请求的条件包括：

- 网络注册状态变化（如从无服务变为有服务）
- 数据漫游状态变化
- 接入网络类型变化（如从 4G 变为 5G）
- 注册域变化（PS 域注册状态变化）

### 5.3 网络请求分组

**位置**：`DataNetworkController.getGroupedUnsatisfiedNetworkRequests()`

系统将所有未满足的网络请求按以下规则分组：

1. **相同能力要求**：需要相同网络能力的请求归为一组
2. **兼容的传输类型**：可以共享同一传输类型的请求归为一组
3. **优先级排序**：每组选择优先级最高的请求作为代表

分组的目的是避免为每个请求单独建立数据网络，提高资源利用率。

### 5.4 DataProfile 选择

**位置**：DataProfileManager.getDataProfileForNetworkRequest()

为每个分组选择合适的 DataProfile，选择逻辑：

1. 过滤出能够满足网络请求能力的 DataProfile
2. 考虑当前网络类型（2G/3G/4G/5G）
3. 考虑是否卫星网络
4. 考虑是否 eSIM 引导配置
5. 排除永久失败的 APN（除非是条件性重试）

### 5.5 创建 DataNetwork 对象

**位置**：DataNetworkController 创建 DataNetwork

```java
mDataNetworkList.add(new DataNetwork(mPhone, mFeatureFlags, getLooper(),
        mDataServiceManagers, dataProfile, networkRequestList, transport, isSatellite,
        allowedReason, new DataNetworkCallback(this::post) {
            @Override
            public void onSetupDataFailed(...) {
                // 建立失败处理
            }
            
            @Override
            public void onConnected(@NonNull DataNetwork dataNetwork) {
                // 连接成功处理
            }
            
            @Override
            public void onDisconnected(...) {
                // 断开处理
            }
            // ... 其他回调
        }));
```

**创建参数**：
- **dataProfile**：用于建立连接的 DataProfile
- **networkRequestList**：此 DataNetwork 需要满足的网络请求列表
- **transport**：传输类型（WWAN/IWLAN）
- **isSatellite**：是否卫星网络
- **allowedReason**：允许建立的原因（如 `ALLOWED_REASON_AIRPLANE_MODE_OFF`）

创建后，DataNetwork 会自动进入连接流程。

---

## 第 6 章：生成 DataNetwork，激活数据业务

### 6.1 DataNetwork.setupData() 流程

**位置**：DataNetwork.setupData()

#### 6.1.1 接入网络类型转换

```java
int accessNetwork = DataUtils.networkTypeToAccessNetworkType(dataNetworkType);
```

将网络类型（如 `NETWORK_TYPE_LTE`）转换为接入网络类型（如 `ACCESS_NETWORK_TYPE_EUTRAN`）。

#### 6.1.2 漫游判断

```java
boolean isModemRoaming = mPhone.getServiceState().getDataRoamingFromRegistration();
boolean allowRoaming = ...; // 根据用户设置和运营商策略决定
```

#### 6.1.3 TrafficDescriptor 构建

对于 5G 网络，需要构建 `TrafficDescriptor`：

```java
TrafficDescriptor trafficDescriptor = new TrafficDescriptor(
        mDataProfile.getApnSetting().getApnName(),  // DNN
        null  // OS App ID
);
```

#### 6.1.4 发起数据呼叫请求

```java
mDataServiceManagers.get(mTransport)
        .setupDataCall(accessNetwork, mDataProfile, isModemRoaming, allowRoaming,
                DataService.REQUEST_REASON_NORMAL, null, mPduSessionId, null,
                trafficDescriptor, matchAllRuleAllowed,
                obtainMessage(EVENT_SETUP_DATA_NETWORK_RESPONSE));
```

### 6.2 DataServiceManager.setupDataCall() 转发

**位置**：DataServiceManager.setupDataCall()

`DataServiceManager` 根据传输类型选择对应的 `IDataService` 实现（WWAN 或 IWLAN），然后调用其 `setupDataCall()` 方法。

### 6.3 CellularDataService.setupDataCall() → RIL

**位置**：CellularDataService.setupDataCall()

```java
public void setupDataCall(int accessNetworkType, @NonNull DataProfile dataProfile,
        boolean isRoaming, boolean allowRoaming, int reason, LinkProperties linkProperties,
        int pduSessionId, NetworkSliceInfo sliceInfo, TrafficDescriptor trafficDescriptor,
        boolean matchAllRuleAllowed, @Nullable DataServiceCallback callback) {
    
    Message message = null;
    if (callback != null) {
        message = Message.obtain(mHandler, SETUP_DATA_CALL_COMPLETE);
        mCallbackMap.put(message, callback);
    }
    
    mPhone.mCi.setupDataCall(accessNetworkType, dataProfile, allowRoaming, reason,
            linkProperties, pduSessionId, sliceInfo, trafficDescriptor, matchAllRuleAllowed,
            message);
}
```

请求最终通过 `mCi.setupDataCall()` 下发到 RIL，RIL 封装为 `RIL_REQUEST_SETUP_DATA_CALL` 发送给 Modem。

### 6.4 Modem 响应处理（onSetupResponse）

**位置**：DataNetwork.onSetupResponse()

```java
private void onSetupResponse(@DataServiceCallback.ResultCode int resultCode,
        @Nullable DataCallResponse response) {
    mFailCause = getFailCauseFromDataCallResponse(resultCode, response);
    
    if (mFailCause == DataFailCause.NONE) {
        // 验证接口名是否已被其他 DataNetwork 使用
        DataNetwork dataNetwork = mDataNetworkController.getDataNetworkByInterface(
                response.getInterfaceName());
        if (dataNetwork != null) {
            // CID 冲突，静默拆除
            mFailCause = DataFailCause.NO_RETRY_FAILURE;
            transitionTo(mDisconnectedState);
            return;
        }
        
        // 验证通过，更新状态
        mDataCallResponse = response;
        mCid.put(mTransport, response.getId());
        
        // 创建 NetworkAgent
        mNetworkAgent = createNetworkAgent();
        
        // 进入 Connected 状态
        transitionTo(mConnectedState);
    } else {
        // 建立失败，进入 Disconnected 状态
        transitionTo(mDisconnectedState);
    }
}
```

**关键处理**：
- **结果码解析**：将 `DataServiceCallback.ResultCode` 转换为 `DataFailCause`
- **响应验证**：检查接口名是否已被占用（CID 冲突）
- **CID 冲突处理**：如果同一接口名被多个 DataNetwork 使用，静默拆除冲突网络

### 6.5 创建 TelephonyNetworkAgent

**位置**：DataNetwork.createNetworkAgent()

```java
private TelephonyNetworkAgent createNetworkAgent() {
    NetworkAgentConfig config = new NetworkAgentConfig.Builder()
            .setLegacyType(ConnectivityManager.TYPE_MOBILE)
            .build();
    
    TelephonyNetworkAgent networkAgent = new TelephonyNetworkAgent(
            mPhone, getHandler().getLooper(), this,
            config, networkCapabilities, linkProperties,
            new TelephonyNetworkAgentCallback(getHandler()::post) {
                // ... 回调实现
            });
    
    networkAgent.register();  // 注册到 ConnectivityService
    
    return networkAgent;
}
```

`TelephonyNetworkAgent` 创建后会调用 `register()` 方法向 ConnectivityService 注册网络。

### 6.6 进入 Connected 状态，回调 onConnected()

当 DataNetwork 进入 Connected 状态后，会触发 `DataNetworkCallback.onConnected()`：

```java
@Override
public void onConnected(@NonNull DataNetwork dataNetwork) {
    DataNetworkController.this.onDataNetworkConnected(dataNetwork);
}
```

**处理内容**：
- 通知所有注册的 `DataNetworkControllerCallback`
- 更新历史连接记录
- 更新 IMS 数据网络状态
- 如果是 eSIM 引导配置，安排重新评估数据使用情况

---

## 第 7 章：更新数据链路相关信息

### 7.1 Modem 上报 RIL_UNSOL_DATA_CALL_LIST_CHANGED

Modem 在以下情况会主动上报数据呼叫列表变化：

- 数据连接建立成功
- 数据连接断开
- 链路状态变化（ACTIVE → INACTIVE）
- 地址/DNS/MTU 等参数变化

### 7.2 接收链路

```
Modem 上报 RIL_UNSOL_DATA_CALL_LIST_CHANGED
  ↓
DataIndication.dataCallListChanged()
  ↓
ServiceStateTracker.notifyDataCallListChanged()
  ↓
DataNetworkController 遍历所有 DataNetwork
  ↓
DataNetwork.onDataStateChanged()
```

### 7.3 DataNetwork.onDataStateChanged() 处理

**位置**：DataNetwork.onDataStateChanged()

```java
private void onDataStateChanged(@TransportType int transport,
        @NonNull List<DataCallResponse> responseList, boolean requireExplicitDisconnect) {
    
    // 过滤出当前 DataNetwork 对应的响应
    DataCallResponse response = responseList.stream()
            .filter(r -> mCid.get(mTransport) == r.getId())
            .findFirst()
            .orElse(null);
    
    if (response != null) {
        if (!response.equals(mDataCallResponse)) {
            validateDataCallResponse(response, -1);
            mDataCallResponse = response;
            
            if (response.getLinkStatus() != DataCallResponse.LINK_STATUS_INACTIVE) {
                // 更新链路信息
                updateDataNetwork(response);
                notifyPreciseDataConnectionState();
            } else {
                // 链路 INACTIVE，断开连接
                mFailCause = mEverConnected ? response.getCause()
                        : DataFailCause.NO_RETRY_FAILURE;
                transitionTo(mDisconnectedState);
            }
        }
    } else {
        // 响应不在列表中，视为 PDN 丢失
        mFailCause = mEverConnected ? DataFailCause.LOST_CONNECTION
                : DataFailCause.NO_RETRY_FAILURE;
        transitionTo(mDisconnectedState);
    }
}
```

**三种情况处理**：
1. **响应存在且非 INACTIVE**：更新链路信息
2. **响应存在但 INACTIVE**：断开连接
3. **响应不存在**：PDN 丢失，断开连接

### 7.4 updateDataNetwork() 更新链路属性

**位置**：DataNetwork.updateDataNetwork()

```java
private void updateDataNetwork(@Nullable DataCallResponse response) {
    if (response == null) return;
    
    LinkProperties linkProperties = new LinkProperties();
    
    // 设置接口名
    linkProperties.setInterfaceName(response.getInterfaceName());
    
    // 设置链路地址
    for (LinkAddress la : response.getAddresses()) {
        if (!la.getAddress().isAnyLocalAddress()) {
            linkProperties.addLinkAddress(la);
        }
    }
    
    // 设置 DNS 服务器
    for (InetAddress dns : response.getDnsAddresses()) {
        if (!dns.isAnyLocalAddress()) {
            linkProperties.addDnsServer(dns);
        }
    }
    
    // 设置 PCSCF 服务器（IMS 专用）
    for (InetAddress pcscf : response.getPcscfAddresses()) {
        linkProperties.addPcscfServer(pcscf);
    }
    
    // 设置 MTU
    int mtuV4 = response.getMtuV4() > 0 ? response.getMtuV4() : response.getMtu();
    if (mtuV4 <= 0) {
        mtuV4 = mDataProfile.getApnSetting() != null
                ? mDataProfile.getApnSetting().getMtuV4()
                : mDataConfigManager.getDefaultMtu();
    }
    linkProperties.setMtu(mtuV4);
    
    // 更新到 NetworkAgent
    mNetworkAgent.sendLinkProperties(linkProperties);
}
```

**更新的链路属性**：
- **接口名**：如 "rmnet0"
- **链路地址**：IPv4/IPv6 地址列表
- **DNS 服务器**：DNS 地址列表
- **PCSCF 服务器**：IMS 会话控制服务器地址
- **MTU**：最大传输单元

### 7.5 updateNetworkCapabilities() 更新网络能力

**位置**：DataNetwork.updateNetworkCapabilities()

```java
private void updateNetworkCapabilities() {
    NetworkCapabilities nc = new NetworkCapabilities();
    
    // 设置基本能力
    nc.addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    nc.addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED);
    
    // 根据 APN 类型添加能力
    if (mDataProfile.canSatisfy(NetworkCapabilities.NET_CAPABILITY_IMS)) {
        nc.addCapability(NetworkCapabilities.NET_CAPABILITY_IMS);
    }
    
    // 设置传输类型
    nc.addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR);
    
    // 更新到 NetworkAgent
    mNetworkAgent.sendNetworkCapabilities(nc);
}
```

**更新的网络能力**：
- **INTERNET**：是否支持互联网访问
- **IMS**：是否支持 IMS（用于 VoLTE/Wi-Fi Calling）
- **TRANSPORT_CELLULAR**：传输类型为蜂窝网络
- **NOT_RESTRICTED**：网络不受限制

### 7.6 TelephonyNetworkAgent 通知 ConnectivityService

`TelephonyNetworkAgent` 通过继承自 `NetworkAgent` 的方法向 ConnectivityService 上报网络信息：

| 方法 | 用途 |
|------|------|
| `sendLinkProperties(LinkProperties)` | 上报链路属性（接口名、地址、DNS 等） |
| `sendNetworkCapabilities(NetworkCapabilities)` | 上报网络能力 |
| `sendNetworkScore(NetworkScore)` | 上报网络评分 |
| `sendNetworkInfo(NetworkInfo)` | 上报网络状态信息 |

ConnectivityService 收到这些信息后，会更新系统网络状态，通知应用网络已就绪。

---

## 第 8 章：异常与重试机制

### 8.1 数据建立失败处理

当 `setupDataCall` 返回失败时，`DataNetwork` 会进入 `Disconnected` 状态，并触发 `onSetupDataFailed` 回调：

```java
@Override
public void onSetupDataFailed(@NonNull DataNetwork dataNetwork,
        @NonNull NetworkRequestList requestList, @DataFailureCause int cause,
        long retryDelayMillis) {
    DataNetworkController.this.onDataNetworkSetupFailed(
            dataNetwork, requestList, cause, retryDelayMillis);
}
```

`DataNetworkController` 会根据失败原因决定是否重试：
- **可重试失败**：如 `DataFailCause.RADIO_NOT_AVAILABLE`，延迟后重试
- **不可重试失败**：如 `DataFailCause.NO_RETRY_FAILURE`，放弃重试

### 8.2 DataRetryManager 重试策略

**文件**：DataRetryManager.java

`DataRetryManager` 管理数据建立的重试逻辑：

- **指数退避**：重试间隔逐渐增加（如 1s → 2s → 4s → 8s）
- **最大重试次数**：超过次数后停止重试
- **条件性重试**：仅在特定条件满足时重试（如 Radio 状态变为可用）
- **周期性重试**：定时检查是否可以重试

### 8.3 PDN 丢失处理

当 Modem 上报的数据呼叫列表中不再包含某个 CID 时，视为 PDN 丢失：

```java
} else if (!(mFlags.supportExplicitDataDisconnect() && requireExplicitDisconnect)) {
    mFailCause = mEverConnected ? DataFailCause.LOST_CONNECTION
            : DataFailCause.NO_RETRY_FAILURE;
    transitionTo(mDisconnectedState);
}
```

**两种断开模式**：
- **显式断开（新 HAL >= 2.4）**：Modem 必须先上报 `LINK_STATUS_INACTIVE`，然后从列表中移除
- **隐式断开（旧 HAL）**：从列表中消失即视为断开

### 8.4 链路状态 INACTIVE 处理

当 Modem 上报链路状态为 `LINK_STATUS_INACTIVE` 时：

```java
if (response.getLinkStatus() == DataCallResponse.LINK_STATUS_INACTIVE) {
    mFailCause = mEverConnected ? response.getCause()
            : DataFailCause.NO_RETRY_FAILURE;
    transitionTo(mDisconnectedState);
}
```

如果曾经连接成功过（`mEverConnected = true`），使用 Modem 返回的原因码；否则使用 `NO_RETRY_FAILURE`。

---

## 第 9 章：调试与日志

### 9.1 关键 Log TAG

| TAG | 类 | 关注点 |
|-----|----|--------|
| `DataProfileManager` | DataProfileManager | APN 加载、DataProfile 创建、preferred/IA 设置 |
| `DataServiceManager` | DataServiceManager | 数据服务连接、请求转发 |
| `CellularDataService` | CellularDataService | RIL 请求下发、响应处理 |
| `DataNetworkController` | DataNetworkController | 网络请求评估、DataNetwork 创建/管理 |
| `DataNetwork` | DataNetwork | 数据建立、状态转换、链路更新 |
| `TelephonyNetworkAgent` | TelephonyNetworkAgent | 网络注册、信息上报 |
| `RILJ` | RIL | RIL 请求/响应、Modem 上报 |
| `DataIndication` | DataIndication | 数据指示消息处理 |

### 9.2 常用过滤命令

```bash
# 查看 DataProfile 设置流程
adb logcat -b radio | grep -E "updateDataProfiles|setDataProfile|setInitialAttachApn|preferredDataProfile|IA DataProfile"

# 查看数据建立流程
adb logcat -b radio | grep -E "setupDataCall|SETUP_DATA_CALL|DataCallResponse|onSetupResponse"

# 查看 DataNetwork 创建和状态变化
adb logcat -b radio | grep -E "DataNetwork|createDataNetwork|onConnected|onDisconnected|onDataStateChanged"

# 查看链路属性更新
adb logcat -b radio | grep -E "updateDataNetwork|LinkProperties|interfaceName|addresses|dnsAddresses|MTU"

# 查看网络能力更新
adb logcat -b radio | grep -E "updateNetworkCapabilities|NetworkCapabilities|INTERNET|IMS"

# 查看数据呼叫列表变化
adb logcat -b radio | grep -E "DATA_CALL_LIST_CHANGED|onDataCallListChanged"
```

### 9.3 dumpsys 调试

```bash
# 查看数据网络状态
adb shell dumpsys telephony.data

# 查看 Telephony 服务信息
adb shell dumpsys telephony.registry

# 查看 APN 配置
adb shell content query --uri content://telephony/carriers/preferapn
```

### 9.4 常见问题排查思路

**问题 1：DataProfile 未加载**
- 检查 SIM 卡状态是否为 `LOADED`
- 查看 `updateDataProfiles` 是否被调用
- 检查 APN 数据库查询是否成功
- 查看 `RIL_REQUEST_SET_DATA_PROFILE` 是否下发成功

**问题 2：数据建立失败**
- 查看 `setupDataCall` 的结果码和失败原因
- 检查 DataProfile 是否正确（APN 名称、协议等）
- 检查网络注册状态是否正常（PS 域是否注册）
- 查看 Modem 返回的 `DataCallResponse` 是否包含错误信息

**问题 3：链路属性未更新**
- 检查 `RIL_UNSOL_DATA_CALL_LIST_CHANGED` 是否上报
- 查看 `onDataStateChanged` 是否收到对应 CID 的响应
- 检查 `updateDataNetwork` 是否正确解析响应
- 查看 `TelephonyNetworkAgent` 是否调用 `sendLinkProperties`

**问题 4：网络未注册到 ConnectivityService**
- 检查 `TelephonyNetworkAgent.register()` 是否调用
- 查看 ConnectivityService 的日志
- 检查 `NetworkCapabilities` 是否包含 `INTERNET` 能力
- 检查 `LinkProperties` 是否包含有效的接口名和地址
