---
title: "高通平台 IMS 注册全流程分析"
date: "2025-06-26"
summary: "基于高通平台，从 CarrierConfig 加载、ImsService 绑定、IMS PDN 建立到 IMS 注册状态上报的完整流程分析，涵盖 AOSP Framework 层与高通私有 IMS APK 层的交互。"
category: "ims"
tags: ["ImsPhoneCallTracker", "ImsResolver", "FeatureConnector", "ImsService", "MmTelFeatureConnection", "CarrierId", "CarrierConfig", "ImsSenderRxr", "ImsRegistrationImpl", "VoLTE", "VoWiFi", "NV73833"]
featured: true
---

## 第 1 章：概述

### 1.1 IMS 是什么

IMS（IP Multimedia Subsystem，IP 多媒体子系统）是一种基于 IP 的网络架构，用于提供语音、视频、消息等多媒体业务。在 Android 蜂窝通信中，IMS 是 VoLTE（Voice over LTE）、ViLTE（Video over LTE）、VoWiFi（Voice over Wi-Fi）、RCS（Rich Communication Suite）等业务的基础。

### 1.2 高通平台 IMS 架构分层

高通平台的 IMS 实现采用分层架构，从下到上依次为：

```
┌─────────────────────────────────────────────┐
│  SystemUI / 应用层                            │
│  （状态栏图标、通话界面、短信应用）              │
├─────────────────────────────────────────────┤
│  AOSP Framework 层                           │
│  ImsPhoneCallTracker / ImsResolver /        │
│  TelephonyRegistry / ImsMmTelManager        │
├─────────────────────────────────────────────┤
│  高通 IMS APK 层（高通私有）                   │
│  ImsServiceSub / ImsRegistrationImpl /      │
│  ImsSenderRxr / ImsConfig                    │
├─────────────────────────────────────────────┤
│  Modem / CNE 层（高通私有）                   │
│  LTE/NR 协议栈 / CNE 连接引擎 / NV 参数       │
└─────────────────────────────────────────────┘
```

各层职责：

| 层级 | 模块 | 职责 |
|------|------|------|
| Modem 层 | LTE/NR 协议栈、CNE、NV | 蜂窝网络注册、IMS PDN 建立、IMS 信令处理 |
| 高通 IMS APK 层 | ImsServiceSub、ImsRegistrationImpl、ImsSenderRxr | IMS 注册、会话管理、与 Modem 通信 |
| AOSP Framework 层 | ImsPhoneCallTracker、ImsResolver、FeatureConnector | IMS 服务管理、通话控制、状态通知 |
| 应用层 | SystemUI、Dialer、Messaging | 用户界面展示 |

> **说明**：高通 IMS APK 层（ImsSenderRxr、ImsServiceSub、ImsRegistrationImpl 等）为高通私有代码，AOSP 中不含实现。本文档将重点阐述 AOSP Framework 层的接口与流程，并对高通专有模块说明其角色与调用关系。

### 1.3 整体流程总览

```
开机 → SIM 卡加载 → CarrierId 识别 → CarrierConfig 加载
  ↓
ImsPhoneCallTracker 创建 FeatureConnector → 注册 FeatureCallback
  ↓
ImsResolver 收到 CARRIER_CONFIG_CHANGED → bind ImsService
  ↓
imsFeatureCreated 回调 → MmTelFeatureConnection 创建
  ↓
connectionReady → 注册 IMS 回调接口
  ↓
Modem LTE/NR 注册 → 激活 IMS PDN → IMS 注册
  ↓
IMS 注册成功 → onRegistered 回调
  ↓
onCapabilitiesStatusChanged → 更新 IMS 能力（VoLTE/VT/VoWiFi/UT）
  ↓
SystemUI 更新 IMS 状态图标
```

---

## 第 2 章：IMS 注册相关参数介绍

### 2.1 CarrierId 与 CarrierResolver

#### 2.1.1 CarrierResolver 作用

**文件**：CarrierResolver.java

CarrierResolver 是 Android 原生引入的运营商识别机制，类似于：
- **MTK 平台**：`opid`（Operator ID）
- **华为平台**：`opkey`（Operator Key）

CarrierResolver 根据 SIM 卡信息匹配运营商，生成唯一的 CarrierId，用于后续的 CarrierConfig 配置加载。

#### 2.1.2 匹配依据

CarrierResolver 根据以下字段区分不同运营商：

| 字段 | 说明 |
|------|------|
| **mcc** | Mobile Country Code，移动国家码 |
| **mnc** | Mobile Network Code，移动网络码 |
| **iccid** | SIM 卡唯一标识 |
| **spn** | Service Provider Name，运营商名称 |
| **GID1** | Group ID Level 1，SIM 卡分组标识 |
| **GID2** | Group ID Level 2，更细的分组标识 |
| **apn** | APN 名称 |

匹配规则存储在 `CarrierIdProvider` 中，通过 `Telephony.Carriers` 数据库表访问。

#### 2.1.3 三个关键 CarrierId

**文件**：CarrierResolver.java#L90-L96

| ID | 变量名 | 说明 |
|----|--------|------|
| 运营商 ID | `mCarrierId` | 基于完整匹配规则（MCC/MNC + ICCID + SPN + GID 等）生成的运营商 ID |
| 具体运营商 ID | `mSpecificCarrierId` | 更细分的运营商 ID，区分同一运营商下的不同品牌/套餐 |
| MNO 运营商 ID | `mMnoCarrierId` | Mobile Network Operator ID，仅由 MCC+MNC 识别，用于同一 MNO 下多个 MVNO 的场景 |

三者关系：
```
mMnoCarrierId ⊇ mCarrierId ⊇ mSpecificCarrierId
```

- 如果运营商没有更细的子品牌，`mSpecificCarrierId == mCarrierId`
- 如果 MCC+MNC 就能唯一识别运营商，`mMnoCarrierId == mCarrierId`

### 2.2 CarrierConfig IMS 相关配置项

CarrierConfigManager 提供了运营商级别的配置，与 IMS 相关的关键配置项：

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `KEY_CARRIER_VOLTE_AVAILABLE_BOOL` | boolean | 运营商是否支持 VoLTE（Voice over LTE） |
| `KEY_CARRIER_VT_AVAILABLE_BOOL` | boolean | 运营商是否支持 VT（Video Telephony，视频通话） |
| `KEY_CARRIER_WFC_IMS_AVAILABLE_BOOL` | boolean | 运营商是否支持 WFC（Wi-Fi Calling，Wi-Fi 通话） |
| `KEY_CARRIER_SUPPORT_SS_OVER_UT_BOOL` | boolean | 是否支持 SS over UT（Supplementary Services over Ut，补充业务通过 Ut 接口） |

这些配置项会影响 IMS 注册时请求的能力集，以及 Modem 是否启用相应功能。

**AP 侧覆盖逻辑**：当 AP 侧 CarrierConfig 配置与 Modem 侧 NV 73833 配置不一致时，**AP 侧配置优先级更高**，会触发 Modem 重新发起 IMS 注册。

### 2.3 Modem 侧参数（高通平台）

高通平台 Modem 侧通过 NV（Non-Volatile，非易失性）参数配置 IMS 相关功能。

#### 2.3.1 NV 73833：IMS 能力配置

| NV 项 | 说明 |
|------|------|
| **NV 73833** | IMS 能力配置项，控制 VoLTE/VT/VoWiFi/UT 等功能的启用状态 |

NV 73833 是一个位掩码，每一位代表一种 IMS 能力是否启用：

| 位 | 能力 | 说明 |
|----|------|------|
| Bit 0 | VoLTE | 语音通话 over LTE |
| Bit 1 | VT | 视频通话 |
| Bit 2 | VoWiFi | Wi-Fi 通话 |
| Bit 3 | UT | 补充业务（XCAP/Ut 接口） |

**AP 覆盖机制**：
- SIM 卡加载完成后，AP 侧会根据 CarrierConfig 重新下发 IMS 能力配置
- 如果 AP 侧配置与 NV 73833 不一致，AP 侧配置会覆盖 Modem 侧配置
- 配置变更后，Modem 会重新发起 IMS 注册

#### 2.3.2 NV 71527：IMS APN 参数配置

| NV 项 | 说明 |
|------|------|
| **NV 71527** | IMS APN 相关参数配置 |

NV 71527 存储 IMS APN 的配置信息，包括：
- APN 名称（如 "ims"）
- APN 类型（IMS）
- 协议类型（IPv4/IPv6）
- 用户名/密码（如果需要）
- 认证方式

#### 2.3.3 IMS profile 与 apns-conf.xml

Modem 侧维护一个 IMS profile 列表，每个 profile 对应一种 IMS 场景（VoLTE、VoWiFi 等）。这些 profile 的参数需要与 `apns-conf.xml` 中的 APN 配置相对应。

**apns-conf.xml 位置**：`/etc/apns-conf.xml`

**对应关系**：
```
apns-conf.xml 中的 IMS APN  ←→  Modem 侧 IMS profile
├── carrier_id           ←→  运营商匹配
├── apn (ims)            ←→  APN 名称
├── type (ims)           ←→  APN 类型
├── protocol             ←→  协议类型
└── auth_type            ←→  认证方式
```

---

## 第 3 章：IMS 注册整体流程

### 3.1 流程总览

IMS 注册整体流程如下：

```
┌────────────────────────────────────────────────────────────┐
│  Modem 侧 LTE/NR 注册后发起 IMS PDN 激活与注册              │
│  - Modem 完成 LTE/NR PS 域注册                              │
│  - 根据 IMS profile 配置发起 PDN 激活                        │
│  - 根据 NV 73833 配置的能力发起 IMS 注册                     │
├────────────────────────────────────────────────────────────┤
│  Modem 侧通过 CNE 通知框架侧 SetUp_data_call                │
│  - CNE（Connectivity Engine）检测到 IMS PDN 建立           │
│  - 通知 Framework 侧建立数据呼叫                             │
│  - Framework 侧创建 DataNetwork（IMS APN）                 │
├────────────────────────────────────────────────────────────┤
│  SIM 加载完成后 AP 下发 IMS 配置与重新注册                   │
│  - SIM 卡信息加载完成                                       │
│  - AP 侧通过 CarrierConfig 下发 IMS 能力配置                 │
│  - 与 NV 73833 不一致 → 触发重新注册                         │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Modem 侧 LTE/NR 注册后发起 IMS PDN 激活与注册

**触发条件**：Modem 完成 LTE 或 NR 的 PS（Packet Switched）域注册。

**执行流程**：

```
Modem LTE/NR 注册成功
  ↓
检查 NV 73833：IMS 功能是否启用？
  ↓ 是
读取 IMS profile 列表
  ↓
选择合适的 IMS profile（根据 MCC/MNC）
  ↓
发起 IMS PDN 激活请求
  ↓
IMS PDN 建立成功（获取 IP 地址）
  ↓
根据 NV 73833 配置的能力集发起 IMS 注册
  ├── VoLTE 注册（如果启用）
  ├── VT 注册（如果启用）
  ├── VoWiFi 注册（如果 Wi-Fi 可用且启用）
  └── UT 注册（如果启用）
  ↓
IMS 注册完成 → 上报注册状态
```

**关键参数**：
- **IMS profile**：定义了 IMS APN、SIP 服务器地址、注册参数等
- **NV 73833**：决定注册哪些 IMS 能力
- **NV 71527**：IMS APN 的具体参数

### 3.3 Modem 通过 CNE 通知框架侧 SetUp_data_call

**CNE（Connectivity Engine）**：高通特有的连接管理引擎，负责管理各种网络连接（蜂窝、Wi-Fi、IMS 等）。

**流程说明**：

```
Modem 侧 IMS PDN 建立成功
  ↓
CNE 检测到新的 PDN 连接
  ↓
CNE 通过 QMI/RIL 接口通知 Framework 侧
  ↓
Framework 侧收到数据连接变化通知
  ↓
DataNetworkController 创建 IMS DataNetwork
  ↓
更新网络状态（LinkProperties / NetworkCapabilities）
  ↓
IMS 应用通过该 PDN 发送注册信令
```

**IMS DataNetwork 特点**：
- APN 类型为 `TYPE_IMS`
- 网络能力包含 `NET_CAPABILITY_IMS`
- 通常不用于普通互联网数据传输
- 对应用户不可见，仅用于 IMS 信令和媒体流

### 3.4 SIM 加载完成后 AP 下发 IMS 配置与重新注册

**触发时机**：SIM 卡信息加载完成（`IccRecords` 加载完成），CarrierConfig 就绪。

**执行流程**：

```
SIM 卡加载完成 → CarrierId 识别 → CarrierConfig 加载
  ↓
读取 IMS 相关 CarrierConfig
  ├── KEY_CARRIER_VOLTE_AVAILABLE_BOOL
  ├── KEY_CARRIER_VT_AVAILABLE_BOOL
  ├── KEY_CARRIER_WFC_IMS_AVAILABLE_BOOL
  └── KEY_CARRIER_SUPPORT_SS_OVER_UT_BOOL
  ↓
与 Modem 侧 NV 73833 配置比较
  ├── 一致 → 无需重新注册
  └── 不一致 → 触发重新注册
              ↓
           通过 ImsService 下发新配置
              ↓
           Modem 更新 NV 73833
              ↓
           重新发起 IMS 注册
```

**为什么 AP 侧配置优先**：
- 运营商策略可能随时调整，通过 AP 侧 CarrierConfig 可以灵活更新
- 不需要修改 Modem 固件就能调整 IMS 能力
- 支持通过运营商配置包（Carrier Services）动态更新

---

## 第 4 章：IMS 相关类初始化

### 4.1 ImsPhoneCallTracker 创建 FeatureConnector

**文件**：ImsPhoneCallTracker.java

#### 4.1.1 FeatureConnector 构造

ImsPhoneCallTracker 在构造函数中创建 `FeatureConnector<ImsManager>`：

```java
mImsManagerConnector = ImsFeatureConnectorFactory.INSTANCE
        .create(mContext, mPhone.getPhoneId(), LOG_TAG,
                new FeatureConnector.Listener<ImsManager>() {
                    public void connectionReady(ImsManager manager, int subId)
                            throws ImsException {
                        log("connectionReady for subId = " + subId);
                        // 连接就绪处理
                    }

                    public void connectionUnavailable(int reason) {
                        // 连接不可用处理
                    }
                }, executor, mTelephonyManager);
```

#### 4.1.2 向 ImsResolver 注册 FeatureCallback

**文件**：FeatureConnector.java

FeatureConnector 通过 `ImsManager.registerFeatureCallback()` 向 ImsResolver 注册回调：

```java
// FeatureConnector 内部的 IImsServiceFeatureCallback
private final IImsServiceFeatureCallback mCallback = new IImsServiceFeatureCallback.Stub() {
    public void imsFeatureCreated(ImsFeatureContainer c, int subId) {
        log("imsFeatureCreated: " + c + ", subId: " + subId);
        if (mManager != null) {
            mManager.associate(c, subId);  // 创建 MmTelFeatureConnection
        }
    }
    // ...
};

// 注册回调
public void connect() {
    ImsManager manager = mTelephonyManager.getImsManager(...);
    manager.registerFeatureCallback(mPhoneId, mCallback);
}
```

**associate 作用**：将 `ImsFeatureContainer` 与 `ImsManager` 关联，创建 `MmTelFeatureConnection`，用于后续的 IMS 通话控制和状态监听。

### 4.2 ImsResolver 收到 CARRIER_CONFIG_CHANGED 触发 bind ImsService

**文件**：ImsResolver.java

#### 4.2.1 ACTION_CARRIER_CONFIG_CHANGED 广播接收

ImsResolver 监听 `CarrierConfigManager.ACTION_CARRIER_CONFIG_CHANGED` 广播：

```
CarrierConfig 加载完成
  ↓
发送 ACTION_CARRIER_CONFIG_CHANGED 广播
  ↓
ImsResolver 收到广播
  ↓
查询当前运营商对应的 ImsService
  ↓
选择优先级最高的 ImsService
  ↓
bindService 绑定 ImsService
```

#### 4.2.2 ImsServiceController bind 流程

ImsResolver 通过 `ImsServiceController` 管理与 ImsService 的绑定：

```
ImsResolver
  ├── ImsServiceController (slot 0)  ← 对应第一个 ImsService
  ├── ImsServiceController (slot 1)  ← 对应第二个 ImsService
  └── ...
```

每个 `ImsServiceController` 负责：
- 绑定到指定的 ImsService
- 管理连接状态（连接中/已连接/断开）
- 上报 IMS Feature 创建/销毁事件

### 4.3 imsFeatureCreated 回调与 MmTelFeatureConnection 创建

#### 4.3.1 FeatureConnector.imsFeatureCreated

**文件**：FeatureConnector.java#L117-L123

当 ImsService 绑定成功并创建了 IMS Feature 后，会通过 `IImsServiceFeatureCallback.imsFeatureCreated()` 回调 Framework：

```java
private final IImsServiceFeatureCallback mCallback = new IImsServiceFeatureCallback.Stub() {
    public void imsFeatureCreated(ImsFeatureContainer c, int subId) {
        log("imsFeatureCreated: " + c + ", subId: " + subId);
        if (mManager != null) {
            mManager.associate(c, subId);  // 创建 MmTelFeatureConnection
            // ...
        }
    }
    // ...
};
```

#### 4.3.2 associate 创建 MmTelFeatureConnection

`ImsManager.associate()` 方法创建 `MmTelFeatureConnection` 对象，它是 Framework 与 ImsService 之间 MmTel Feature 的连接通道：

```
ImsManager.associate(ImsFeatureContainer, subId)
  ↓
创建 MmTelFeatureConnection
  ↓
获取 IImsMmTelFeature 接口
  ↓
通过 Binder 与 ImsService 通信
```

`MmTelFeatureConnection` 封装了所有 MmTel 相关的接口调用：
- 通话控制（dial、hold、merge 等）
- 注册状态监听
- 能力状态监听
- 补充业务控制

### 4.4 connectionReady 与回调注册

#### 4.4.1 FeatureConnector.connectionReady

当 MmTelFeatureConnection 创建完成且状态就绪后，FeatureConnector 调用 `connectionReady()` 通知监听器：

**文件**：ImsPhoneCallTracker.java#L1319-L1334

```java
public void connectionReady(ImsManager manager, int subId) throws ImsException {
    log("connectionReady for subId = " + subId);
    // ...
    // 注册 IMS 回调接口
    manager.addCapabilitiesCallback(mExecutor, mCapabilityCallback);
    manager.registerMmTelFeatureStateCallback(mExecutor, mStateCallback);
    manager.registerImsRegistrationCallback(mExecutor, mRegistrationCallback);
    // ...
    // 设置通话监听
    manager.getMmTelFeature().addCallListener(mImsCallListener);
}
```

#### 4.4.2 注册的回调接口

ImsPhoneCallTracker 在 connectionReady 后会注册多个回调，用于监听 IMS 状态：

| 回调 | 用途 |
|------|------|
| `CapabilitiesCallback` | 监听 IMS 能力变化（VoLTE/VT/VoWiFi/UT） |
| `MmTelFeatureStateCallback` | 监听 MmTel Feature 状态 |
| `ImsRegistrationCallback` | 监听 IMS 注册状态（注册/未注册/注册失败） |
| `ImsCallListener` | 监听 IMS 通话事件（来电、通话状态变化） |

### 4.5 onCapabilitiesStatusChanged 与 IMS 能力更新

#### 4.5.1 ImsPhoneCallTracker.onCapabilitiesStatusChanged

**文件**：ImsPhoneCallTracker.java#L4602-L4611

当 IMS 注册状态或能力变化时，ImsService 会通过回调通知 Framework：

```java
private final ImsMmTelManager.CapabilityCallback mCapabilityCallback =
        new ImsMmTelManager.CapabilityCallback() {
            public void onCapabilitiesStatusChanged(
                    MmTelFeature.MmTelCapabilities capabilities) {
                if (DBG) log("onCapabilitiesStatusChanged: " + capabilities);
                SomeArgs args = SomeArgs.obtain();
                args.arg1 = capabilities;
                removeMessages(EVENT_ON_FEATURE_CAPABILITY_CHANGED);
                obtainMessage(EVENT_ON_FEATURE_CAPABILITY_CHANGED, args).sendToTarget();
            }
        };
```

回调通过 Handler 消息 `EVENT_ON_FEATURE_CAPABILITY_CHANGED` 切换到 ImsPhoneCallTracker 所在线程处理。

#### 4.5.2 handleFeatureCapabilityChanged 处理

**文件**：ImsPhoneCallTracker.java#L5833-L5873

```java
private void handleFeatureCapabilityChanged(ImsFeature.Capabilities capabilities) {
    mMmTelCapabilities = new MmTelFeature.MmTelCapabilities(capabilities);

    // 视频能力变化通知
    if (isVideoEnabledStateChanged) {
        mPhone.notifyForVideoCapabilityChanged(isVideoEnabled);
    }

    // 日志记录
    String logMessage = "handleFeatureCapabilityChanged: isVolteEnabled="
            + isVoiceOverCellularImsEnabled()
            + ", isVideoCallEnabled=" + isVideoCallEnabled()
            + ", isVowifiEnabled=" + isVowifiEnabled()
            + ", isUtEnabled=" + isUtEnabled();
    mRegLocalLog.log(logMessage);

    mPhone.onFeatureCapabilityChanged();

    // 更新 IMS 统计
    int regTech = getImsRegistrationTech();
    mPhone.getImsStats().onImsCapabilitiesChanged(regTech, mMmTelCapabilities);
}
```

**处理内容**：
1. 更新 `mMmTelCapabilities`（存储当前 IMS 能力）
2. 检查视频能力是否变化，变化则通知 Phone
3. 记录日志
4. 调用 `mPhone.onFeatureCapabilityChanged()` 通知 Phone 层
5. 更新 IMS 统计信息

---

## 第 5 章：IMS 注册状态上报

### 5.1 高通 IMS APK 侧架构

高通 IMS APK 是高通平台 IMS 实现的核心，运行在应用层，通过 Binder 与 Framework 通信，通过 QMI/RIL 与 Modem 通信。

#### 5.1.1 ImsSenderRxr

| 模块 | 说明 |
|------|------|
| **ImsSenderRxr** | 高通 IMS APK 中的通信模块，负责与 Modem 侧 IMS 协议栈通信 |

主要职责：
- 通过 QMI（Qualcomm MSM Interface）与 Modem 通信
- 发送 IMS 注册请求、通话控制请求等
- 接收 Modem 上报的注册状态、来电通知等
- 序列化/反序列化 IMS 消息

#### 5.1.2 ImsServiceSub

| 模块 | 说明 |
|------|------|
| **ImsServiceSub** | 高通 IMS APK 中 ImsService 的具体实现类 |

主要职责：
- 实现 AOSP 定义的 `ImsService` 接口
- 管理 MMTel Feature、RCS Feature 等
- 作为 Framework 与高通 IMS 内部实现之间的桥梁
- 对每个 subscription 创建独立的 ImsServiceSub 实例

#### 5.1.3 ImsRegistrationImpl

| 模块 | 说明 |
|------|------|
| **ImsRegistrationImpl** | IMS 注册逻辑的具体实现 |

主要职责：
- 管理 IMS 注册状态机（未注册 → 注册中 → 已注册 → 注销）
- 处理注册失败重试逻辑
- 维护 IMS 注册参数（SIP 服务器、鉴权信息等）
- 上报注册状态变化到 Framework

### 5.2 注册状态上报链路

#### 5.2.1 注册状态上报完整链路

```
Modem IMS 协议栈
  ↓（QMI 上报）
ImsSenderRxr（高通私有）
  ↓
ImsRegistrationImpl（高通私有）
  ↓（接口调用）
ImsServiceSub（高通私有）
  ↓（Binder）
ImsRegistrationCallbackHelper  ←  AOSP 公开接口
  ├── onRegistered(transportType)
  ├── onRegistering(transportType)
  ├── onDeregistered(ImsReasonInfo)
  └── onTechnologyChangeFailed(...)
  ↓
ImsMmTelManager / RegistrationManager
  ↓（Binder 回调）
ImsPhoneCallTracker.ImsRegistrationCallback
  ↓
Handler 消息处理
  ↓
更新注册状态 → 通知 Phone → 更新状态栏
```

#### 5.2.2 onRegistered 回调

当 IMS 注册成功时，会触发 `onRegistered()` 回调：

```
ImsService 侧注册成功
  ↓
ImsRegistrationCallbackHelper.onRegistered(transportType)
  ↓
Framework 侧 ImsMmTelManager.RegistrationCallback.onRegistered()
  ↓
ImsPhoneCallTracker.mRegistrationCallback.onRegistered()
  ↓
更新 IMS 注册技术类型
  ↓
注册状态变化 → 触发 onCapabilitiesStatusChanged
  ↓
SystemUI 更新信号图标和 IMS 状态
```

#### 5.2.3 handleImsRegistered 处理

`handleImsRegistered` 是注册成功后的核心处理方法：

**处理内容**：
1. 保存注册技术类型（LTE / NR / IWLAN）
2. 更新注册状态为已注册
3. 触发能力更新通知
4. 记录注册统计信息
5. 通知 Phone 层 IMS 注册状态变化

---

## 第 6 章：IMS 能力更新流程

### 6.1 能力更新触发时机

IMS 能力更新可能由以下事件触发：

| 触发事件 | 说明 |
|---------|------|
| IMS 注册成功 | 注册成功后上报当前可用能力 |
| IMS 注销 | 注销后所有能力不可用 |
| 注册技术变化 | LTE → NR 切换，能力可能变化 |
| Wi-Fi 连接变化 | VoWiFi 能力随 Wi-Fi 状态变化 |
| CarrierConfig 变化 | 运营商配置更新导致能力变化 |
| Modem 能力变化 | Modem 侧能力配置更新 |
| APP 侧配置变化 | 用户修改 VoLTE/VoWiFi 设置 |

### 6.2 ImsMmTelManager.onCapabilitiesStatusChanged

**文件**：ImsMmTelManager.java#L176-L186

ImsService 通过 `IImsCapabilityCallback` 接口向 Framework 上报能力变化：

```java
private final IImsCapabilityCallback.Stub mBinder = new IImsCapabilityCallback.Stub() {
    public void onCapabilitiesStatusChanged(int config) {
        if (mLocalCallback == null) return;
        final long callingIdentity = Binder.clearCallingIdentity();
        try {
            mExecutor.execute(() -> mLocalCallback.onCapabilitiesStatusChanged(
                    new MmTelFeature.MmTelCapabilities(config)));
        } finally {
            restoreCallingIdentity(callingIdentity);
        }
    }
    // ...
};
```

**注意点**：
- 通过 Binder 调用，需要清除调用者身份（`clearCallingIdentity`）
- 回调在指定的 `Executor` 线程上执行
- `config` 是一个位掩码，每一位代表一种能力是否启用

### 6.3 ImsPhoneCallTracker.handleFeatureCapabilityChanged

**文件**：ImsPhoneCallTracker.java#L5833-L5873

#### 6.3.1 能力位解析

`MmTelCapabilities` 封装了 IMS 能力位，常用能力包括：

| 能力位 | 名称 | 说明 |
|--------|------|------|
| CAPABILITY_TYPE_VOICE | 语音通话 | VoLTE / VoWiFi 语音 |
| CAPABILITY_TYPE_VIDEO | 视频通话 | ViLTE / ViWiFi 视频 |
| CAPABILITY_TYPE_UT | 补充业务 | XCAP / Ut 接口 |
| CAPABILITY_TYPE_SMS | 短信 | IMS SMS |

#### 6.3.2 处理流程

```
handleFeatureCapabilityChanged(capabilities)
  ↓
保存 mMmTelCapabilities = new MmTelCapabilities(capabilities)
  ↓
检查视频能力变化
  ├── 变化 → mPhone.notifyForVideoCapabilityChanged()
  └── 不变 → 跳过
  ↓
记录日志（VoLTE/VT/VoWiFi/UT 状态）
  ↓
mPhone.onFeatureCapabilityChanged()
  ↓
IMS 统计更新 onImsCapabilitiesChanged()
```

#### 6.3.3 能力查询方法

ImsPhoneCallTracker 提供了查询 IMS 能力的方法：

| 方法 | 说明 |
|------|------|
| `isVoiceOverCellularImsEnabled()` | 蜂窝网络 VoLTE 是否启用 |
| `isVoiceOverWifiImsEnabled()` | Wi-Fi 通话是否启用 |
| `isVideoCallEnabled()` | 视频通话是否启用 |
| `isUtEnabled()` | UT 补充业务是否启用 |

这些方法基于 `mMmTelCapabilities` 中的能力位判断。

---

## 第 7 章：调试与日志

### 7.1 关键 Log TAG

| TAG | 模块 | 关注点 |
|-----|------|--------|
| `ImsPhoneCallTracker` | ImsPhoneCallTracker | IMS 通话追踪、能力变化、注册状态 |
| `ImsResolver` | ImsResolver | ImsService 绑定、Feature 创建 |
| `FeatureConnector` | FeatureConnector | Feature 连接状态变化 |
| `CarrierResolver` | CarrierResolver | CarrierId 识别、运营商匹配 |
| `ImsService` | 高通 IMS APK | IMS 服务状态 |
| `ImsRegistration` | 高通 IMS APK | IMS 注册状态 |
| `RILJ` | RIL | RIL 请求与响应 |

### 7.2 常用过滤命令

```bash
adb logcat -b radio | grep -E "ImsPhoneCallTracker|onRegistered|onDeregistered|onCapabilitiesStatusChanged"

adb logcat -b radio | grep -E "ImsResolver|ImsServiceController|bindService|imsFeatureCreated"

adb logcat -b radio | grep -E "FeatureConnector|connectionReady|connectionUnavailable|associate"

adb logcat -b radio | grep -E "CarrierResolver|mCarrierId|mSpecificCarrierId|mMnoCarrierId"

adb logcat -b all | grep -E "CarrierConfig|ACTION_CARRIER_CONFIG_CHANGED|VOLTE_AVAILABLE|WFC_IMS_AVAILABLE"

adb logcat -b radio | grep -E "handleFeatureCapabilityChanged|isVolteEnabled|isVowifiEnabled|isUtEnabled"
```

### 7.3 dumpsys 调试

```bash
adb shell dumpsys telecom.ims

adb shell dumpsys telephony.registry | grep -A 20 "Ims"

adb shell cmd phone ims register state

adb shell dumpsys isms | grep -A 5 "CarrierId"

adb shell dumpsys telecom | grep -A 10 "MmTel"
```

### 7.4 常见问题排查思路

**问题 1：IMS 服务未绑定**
- 检查 ImsResolver 是否收到 `ACTION_CARRIER_CONFIG_CHANGED`
- 查看 CarrierId 是否正确识别
- 确认 ImsService APK 是否安装且启用
- 查看 ImsServiceController bind 状态

**问题 2：IMS 注册失败**
- 检查 IMS PDN 是否建立成功（APN 是否正确）
- 查看 Modem 侧 NV 73833 / NV 71527 配置
- 检查 CarrierConfig 中 IMS 相关配置是否正确
- 查看注册失败原因码（`onDeregistered` 的 `ImsReasonInfo`）
- 确认 SIP 服务器地址是否可达

**问题 3：VoLTE 不显示**
- 检查 `onCapabilitiesStatusChanged` 是否上报 VoLTE 能力
- 确认 `KEY_CARRIER_VOLTE_AVAILABLE_BOOL` 配置
- 查看 IMS 是否注册在 LTE 上（`getImsRegistrationTech`）
- 检查 `isVoiceOverCellularImsEnabled()` 返回值

**问题 4：Wi-Fi Calling 不工作**
- 检查 `KEY_CARRIER_WFC_IMS_AVAILABLE_BOOL` 配置
- 确认 Wi-Fi 连接正常
- 查看 IMS 是否注册在 IWLAN 上
- 检查 ePDG 连接是否成功

**问题 5：AP 配置不生效**
- 确认 CarrierConfig 是否正确加载
- 检查 CarrierId 是否匹配目标运营商
- 查看 AP 侧配置是否成功下发到 Modem
- 确认配置变更后是否触发了重新注册