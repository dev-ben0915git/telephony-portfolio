---
title: "Android WiFi与蜂窝数据切换及NetworkScore评分机制深度解析"
date: "2026-07-01"
summary: "深入剖析 Android S+ NetworkScore 策略位图机制与 NetworkRanker 11步策略筛选链，完整追踪 WiFi 与蜂窝数据之间的默认网络切换流程：从 ConnectivityService 触发 rematch 到 computeNetworkReassignment 决策、applyNetworkReassignment 执行、makeDefault 最终切换，涵盖 YieldToBadWiFi 策略、Transport 优先级顺序与防乒乓切换机制。"
category: "network-management"
tags: ["ConnectivityService", "NetworkRanker", "FullScore", "NetworkScore", "NetworkAgent", "NetworkOffer", "TelephonyNetworkAgent", "NetworkCapabilities", "YieldToBadWiFi", "rematchNetworksAndRequests", "computeNetworkReassignment", "makeDefault", "netd", "Transport优先级", "策略位图", "WiFi", "蜂窝数据"]
featured: true
---

## 1 概述与背景

### 1.1 Android网络连接管理架构

Android系统的网络连接管理由 `ConnectivityService` 统一负责。作为系统核心服务之一，它维护着所有可用网络的注册信息、应用的网络请求，并持续评估哪个网络最适合作为默认网络。当多个网络同时可用时（例如WiFi和蜂窝数据同时开启），`ConnectivityService` 需要做出智能决策，选择最优网络供系统和应用使用。

本文档聚焦于 **WiFi与蜂窝数据之间的切换机制**，深入剖析从网络状态变化到最终完成切换的完整流程，重点解析 `NetworkScore` 评分系统的工作原理，以及系统如何通过代码实现WiFi优先于蜂窝数据的策略。

### 1.2 评分机制的演进

在 Android R（API 30）及更早版本中，网络优先级通过一个简单的 **0-100整数评分** 来决定：每个 `NetworkAgent` 向 `ConnectivityService` 上报一个整数分数，`ConnectivityService` 选择分数最高的网络作为默认网络。WiFi的基准分数为60，蜂窝网络的基准分数为50，这种固定差距确保了WiFi的优先地位。

从 Android S（API 31）开始，Google对评分机制进行了根本性重构，引入了 **64位策略位图（Policy Bitmap）** 机制。新的 `NetworkScore` 不再是一个简单的整数，而是一个包含多个策略位（Policy Bit）的复合数据结构。`ConnectivityService` 通过 `NetworkRanker` 组件，按照预设的策略优先级逐级筛选，最终选出最佳网络。

```java
// NetworkRanker.java 中关于 legacy int 的注释
public static final int LEGACY_INT_MAX = 100;
```

这一演进使得网络优先级决策更加灵活和可扩展：新增优先级维度只需增加一个策略位，而不需要修改评分算法本身。

### 1.3 文档范围

本文档基于 Android S+ AOSP源码，重点覆盖以下内容：

- 默认网络切换的完整调用链
- `NetworkScore` / `FullScore` 策略位图的设计与实现
- `NetworkRanker` 的网络排名策略链
- WiFi优先于蜂窝数据的多层机制实现
- 关键源码文件的逐段分析

## 2 核心架构与关键类关系

### 2.1 关键类职责说明

| 类名 | 职责 | 源码文件 |
|------|------|---------|
| `ConnectivityService` | 网络连接管理的核心服务，处理所有网络注册、请求匹配、默认网络切换 | `Connectivity/service/src/com/android/server/ConnectivityService.java` |
| `NetworkRanker` | 网络排名器，根据策略位图为请求找出最佳网络 | `Connectivity/service/src/com/android/server/connectivity/NetworkRanker.java` |
| `FullScore` | 完整的网络评分，包含CS管理和Agent管理的所有策略位 | `Connectivity/service/src/com/android/server/connectivity/FullScore.java` |
| `NetworkScore` | Agent提供的网络评分，包含Agent管理的策略位 | `Connectivity/framework/src/android/net/NetworkScore.java` |
| `NetworkCapabilities` | 描述网络能力（传输类型、带宽、各种capability） | `Connectivity/framework/src/android/net/NetworkCapabilities.java` |
| `NetworkAgent` | 网络代理基类，各传输类型（WiFi/Cell/Ethernet）继承此类 | `Connectivity/framework/src/android/net/NetworkAgent.java` |
| `NetworkAgentInfo` | ConnectivityService内部使用的网络信息聚合类，实现Scoreable接口 | `Connectivity/service/src/com/android/server/connectivity/NetworkAgentInfo.java` |
| `NetworkFactory` | 网络工厂，负责创建和管理特定类型的网络 | `Connectivity/staticlibs/device/android/net/NetworkFactory.java` |
| `NetworkOffer` | 网络供应，表示网络提供者可以提供的网络特性 | `Connectivity/service/src/com/android/server/connectivity/NetworkOffer.java` |
| `TelephonyNetworkAgent` | 蜂窝网络代理，telephony模块实现 | `telephony/src/java/com/android/internal/telephony/data/TelephonyNetworkAgent.java` |

### 2.2 核心类关系图

```
ConnectivityService
  ├── mNetworkRanker : NetworkRanker
  ├── mNetworkAgentInfos : ArrayList<NetworkAgentInfo>
  └── mNetworkOffers : ArrayList<NetworkOfferInfo>

NetworkRanker
  └── getBestNetwork() / getBestNetworkByPolicy()

Scoreable (interface)
  └── NetworkAgentInfo (implements)
        ├── networkCapabilities : NetworkCapabilities
        ├── linkProperties : LinkProperties
        └── score : FullScore

FullScore
  └── mPolicies : long (64-bit 策略位图)
        ├── CS管理策略位 (bit 63 ~ bit 54)
        └── Agent管理策略位 (bit 31 ~ bit 0)

NetworkScore
  └── mPolicies : long / mLegacyInt : int

NetworkAgent → sends → NetworkScore + NetworkCapabilities
  └── TelephonyNetworkAgent (extends NetworkAgent)
```

### 2.3 架构层次说明

整个网络切换架构可分为三个层次：

**1. 网络提供层**
- `NetworkAgent` 及其子类（`TelephonyNetworkAgent`、WiFi的 `ClientModeImpl` 等）负责向 `ConnectivityService` 注册网络
- 每个网络提供自己的 `NetworkCapabilities`（能力）和 `NetworkScore`（评分）

**2. 网络管理层**
- `ConnectivityService` 维护所有 `NetworkAgentInfo`（网络信息聚合体）
- 当网络状态变化时，触发 `rematchAllNetworksAndRequests()` 重新评估

**3. 网络排名层**
- `NetworkRanker` 负责在多个候选网络中选出最佳网络
- 通过 `getBestNetworkByPolicy()` 方法实现11步策略筛选链

## 3 NetworkScore评分机制深度解析

### 3.1 评分机制演进：Legacy Int → 策略位图

Android S 之前的评分系统简单直接：每个网络用一个 0-100 的整数表示优先级。`ConnectivityService` 直接比较整数大小，选择分数最高的网络。

```java
// Android R 及之前的评分方式
NetworkAgent.WIFI_BASE_SCORE = 60;  // WiFi基准分数
NetworkAgent.SCORE_FILTER_NONE = 0;
```

这种方式的问题在于：
- 新增优先级维度困难，需要重新定义分数映射
- 分数语义不透明，难以调试
- 不同传输类型的分数容易冲突

Android S 引入的策略位图机制彻底解决了这些问题。新机制下，网络排名不再是比较整数大小，而是按照 **预设的策略优先级链逐级筛选**。每个策略位代表一个布尔条件（满足/不满足），`NetworkRanker` 从高到低依次检查每个策略，将不满足条件的网络淘汰，直到只剩下唯一候选者。

### 3.2 NetworkScore结构（Agent管理策略）

`NetworkScore` 由 `NetworkAgent`（或其子类）创建并上报，包含 Agent 管理的策略位：

```java
// NetworkScore.java
public class NetworkScore implements Parcelable {
    private final long mPolicies;  // 策略位图
    private final int mLegacyInt;   // 遗留整数（仅用于日志和兼容）
    private final int mKeepConnectedReason;

    // Agent 管理的策略位
    public static final int POLICY_YIELD_TO_BAD_WIFI = 1;    // 向劣质WiFi让步
    public static final int POLICY_TRANSPORT_PRIMARY = 2;    // 该传输类型的主网络
    public static final int POLICY_EXITING = 3;              // 网络即将断开
    public static final int POLICY_VCN = 4;                  // VCN网络
}
```

| 策略位 | 数值 | 含义 | 典型设置者 |
|--------|------|------|-----------|
| `POLICY_YIELD_TO_BAD_WIFI` | 1 | 蜂窝网络自动获得此位，表示愿意让位于曾经验证过的WiFi | ConnectivityService 动态计算 |
| `POLICY_TRANSPORT_PRIMARY` | 2 | 表示这是同类型传输中的主网络 | 各NetworkAgent |
| `POLICY_EXITING` | 3 | 网络即将断开，不应选为默认网络 | 网络断开前设置 |
| `POLICY_VCN` | 4 | VCN（Virtual Carrier Network）网络 | VCN模块 |

### 3.3 FullScore结构（CS管理策略）

`FullScore` 是 `ConnectivityService` 内部使用的完整评分，它将 `NetworkScore`（Agent管理策略）与系统状态（CS管理策略）组合成一个64位策略位图：

```java
// FullScore.java
public class FullScore {
    // CS 管理的策略位（从 bit 63 向下使用）
    public static final int POLICY_IS_VALIDATED = 63;           // 网络已验证（通过Internet检测）
    public static final int POLICY_EVER_VALIDATED = 62;         // 曾经验证过
    public static final int POLICY_IS_VPN = 61;                 // 是VPN网络
    public static final int POLICY_EVER_USER_SELECTED = 60;     // 用户曾手动选择
    public static final int POLICY_ACCEPT_UNVALIDATED = 59;     // 接受未验证网络
    public static final int POLICY_AVOIDED_WHEN_UNVALIDATED = 58; // 未验证时避免
    public static final int POLICY_IS_UNMETERED = 57;           // 不计费网络
    public static final int POLICY_IS_INVINCIBLE = 56;          // 无敌（预留offer）
    public static final int POLICY_EVER_EVALUATED = 55;         // 已评估过
    public static final int POLICY_IS_DESTROYED = 54;           // 已销毁待替换

    private final long mPolicies;  // 64位策略位图
    private final int mKeepConnectedReason;
}
```

**位图布局：**

```
┌─────────────────────────────────────────────────────────────────┐
│                        64-bit 策略位图                            │
├─────────────────────────────────────────────────────────────────┤
│  bit 63 ~ bit 54          │  bit 32        │  bit 31 ~ bit 0   │
│  CS管理策略位              │   保留/未使用   │  Agent管理策略位   │
│  (POLICY_IS_VALIDATED     │                │  (YIELD_TO_BAD_   │
│   POLICY_EVER_VALIDATED   │                │   WIFI, TRANSPORT │
│   POLICY_IS_VPN, ...)     │                │   _PRIMARY, ...)  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.4 评分构建流程

当 `NetworkAgent` 注册网络或更新状态时，`ConnectivityService` 调用 `FullScore.fromNetworkScore()` 构建完整的评分：

```java
// FullScore.java (line 167)
public static FullScore fromNetworkScore(@NonNull final NetworkScore score,
        @NonNull final NetworkCapabilities caps, @NonNull final NetworkAgentConfig config,
        final boolean everValidated, final boolean avoidUnvalidated,
        final boolean yieldToBadWiFi, final boolean everEvaluated, final boolean destroyed) {
    return withPolicies(score.getPolicies(),
            score.getKeepConnectedReason(),
            caps.hasCapability(NET_CAPABILITY_VALIDATED),    // 是否已验证
            everValidated,                                    // 是否曾经验证
            caps.hasTransport(TRANSPORT_VPN),                // 是否VPN
            config.explicitlySelected,                        // 用户是否手动选择
            config.acceptUnvalidated,                         // 是否接受未验证
            avoidUnvalidated,                                 // 未验证时是否避免
            caps.hasCapability(NET_CAPABILITY_NOT_METERED),  // 是否不计费
            yieldToBadWiFi,
            false /* invincible */,
            everEvaluated,
            destroyed);
}
```

这个方法的核心逻辑：

1. **Agent策略位**：直接取自 `NetworkScore.getPolicies()`
2. **验证状态**：根据 `NET_CAPABILITY_VALIDATED` 设置 `POLICY_IS_VALIDATED`
3. **用户偏好**：根据 `NetworkAgentConfig` 设置 `POLICY_EVER_USER_SELECTED`、`POLICY_ACCEPT_UNVALIDATED`
4. **传输类型**：根据 `NetworkCapabilities` 中的 transport 设置相关策略
5. **计费状态**：根据 `NET_CAPABILITY_NOT_METERED` 设置 `POLICY_IS_UNMETERED`

### 3.5 策略位掩码设计

`FullScore` 使用位掩码区分 Agent 可修改的策略和 CS 独占的策略：

```java
// FullScore.java (line 115-121)
private static final long EXTERNAL_POLICIES_MASK =
        0x00000000FFFFFFFFL & ~(1L << POLICY_YIELD_TO_BAD_WIFI);
```

- `0x00000000FFFFFFFFL`：允许 Agent 修改低32位策略
- `~(1L << POLICY_YIELD_TO_BAD_WIFI)`：但 `POLICY_YIELD_TO_BAD_WIFI` 除外（CS特殊控制）
- CS 管理的策略位从 bit 63 向下使用，Agent 无法直接修改

这种设计确保了系统可以对关键策略（如验证状态、VPN标识）进行集中管控，同时允许网络提供者表达自身偏好（如是否向WiFi让步）。

## 4 网络切换全流程解析

### 4.1 切换触发条件

以下事件会触发 `ConnectivityService` 重新评估所有网络和请求：

| 触发条件 | 说明 |
|---------|------|
| 新网络连接/注册 | `NetworkAgent.register()` 被调用 |
| 网络断开/注销 | `NetworkAgent.unregister()` 被调用 |
| 网络能力变化 | `sendNetworkCapabilities()` 上报新能力 |
| 网络评分变化 | `sendNetworkScore()` 上报新评分 |
| 网络验证状态变化 | `NetworkMonitor` 完成/失败Internet检测 |
| 用户偏好设置变化 | 如切换"默认数据卡"、开关飞行模式 |

### 4.2 核心切换流程四步曲

```
网络状态变化
  ↓
rematchAllNetworksAndRequests()         —— 入口
  ↓
computeNetworkReassignment()             —— 决策
  ├── 收集所有 NetworkAgentInfo
  ├── 遍历每个 NetworkRequest
  ├── NetworkRanker.getBestNetwork()     —— 策略筛选
  └── 构建 NetworkReassignment
  ↓
applyNetworkReassignment()               —— 执行
  ├── updateSatisfiersForRematchRequest()
  ├── processDefaultNetworkChanges()
  │   └── makeDefault() → netd.networkSetDefault()
  ├── 发送回调通知 (onAvailable / onLost)
  └── teardownUnneededNetwork()
  ↓
issueNetworkNeeds()                     —— 发布需求
```

### 4.3 `rematchAllNetworksAndRequests()` 详解

这是网络切换的入口方法，负责协调整个重新匹配过程：

```java
// ConnectivityService.java (line 13092)
private void rematchAllNetworksAndRequests() {
    rematchNetworksAndRequests(getNrisFromGlobalRequests());
}

private void rematchNetworksAndRequests(@NonNull final Set<NetworkRequestInfo> networkRequests) {
    final long start = SystemClock.elapsedRealtime();
    final NetworkReassignment changes = computeNetworkReassignment(networkRequests);
    final long computed = SystemClock.elapsedRealtime();
    applyNetworkReassignment(changes, start);
    final long applied = SystemClock.elapsedRealtime();
    issueNetworkNeeds();
    
    log(String.format("Rematched networks [computed %dms] [applied %dms]",
            computed - start, applied - computed));
}
```

流程分为三个阶段：
1. **计算（compute）**：分析所有网络请求，确定每个请求应由哪个网络满足
2. **应用（apply）**：将计算结果应用到系统状态，包括设置默认网络、发送回调
3. **发布需求（issue needs）**：通知网络提供者哪些网络需要保持/可以释放

### 4.4 `computeNetworkReassignment()` 详解

这是切换决策的核心，负责为每个网络请求选出最佳网络：

```java
// ConnectivityService.java (line 13048)
private NetworkReassignment computeNetworkReassignment(
        @NonNull final Collection<NetworkRequestInfo> networkRequests) {
    final NetworkReassignment changes = new NetworkReassignment();
    
    for (final NetworkRequestInfo nri : networkRequests) {
        for (final NetworkRequest req : nri.mRequests) {
            // 收集满足此请求的所有候选网络
            final ArrayList<NetworkAgentInfo> candidates = new ArrayList<>();
            for (NetworkAgentInfo nai : mNetworkAgentInfos) {
                if (nai.satisfies(req)) candidates.add(nai);
            }
            
            // 核心：调用NetworkRanker选出最佳网络
            final NetworkAgentInfo bestNetwork = 
                mNetworkRanker.getBestNetwork(req, candidates, nri.getSatisfier());
            
            // 如果最佳网络发生变化，记录切换
            if (nri.getSatisfier() != bestNetwork) {
                changes.addRequestReassignment(nri, bestNetwork);
            }
        }
    }
    return changes;
}
```

关键逻辑：
1. 遍历每个 `NetworkRequestInfo`（包含一个或多个 `NetworkRequest`）
2. 对每个请求，收集所有 `satisfies()` 返回 true 的 `NetworkAgentInfo`
3. 调用 `NetworkRanker.getBestNetwork()` 在候选者中选出最佳网络
4. 如果最佳网络与当前满足者不同，将变化记录到 `NetworkReassignment`

### 4.5 `applyNetworkReassignment()` 详解

计算完成后，`applyNetworkReassignment()` 负责将决策结果落实到系统：

```java
// ConnectivityService.java (line 13130)
private void applyNetworkReassignment(@NonNull final NetworkReassignment changes, final long now) {
    // 1. 更新各网络的 satisfied requests 列表
    for (NetworkRequestInfo nri : changes.getReassignedRequests()) {
        updateSatisfiersForRematchRequest(nri);
    }
    
    // 2. 处理默认网络变化（核心切换点）
    processDefaultNetworkChanges(changes);
    
    // 3. 通知应用网络可用/丢失
    for (NetworkRequestInfo nri : changes.getNewlySatisfiedRequests()) {
        notifyNetworkAvailable(nri);
    }
    for (NetworkRequestInfo nri : changes.getNewlyUnsatisfiedRequests()) {
        callCallbackForRequest(nri, CALLBACK_LOST);
    }
    
    // 4. 更新不活跃状态和 Linger 定时器
    for (NetworkAgentInfo nai : mNetworkAgentInfos) {
        updateInactivityState(nai, now);
    }
    
    // 5. 拆除不再需要的网络
    for (NetworkAgentInfo nai : changes.getUnneededNetworks()) {
        teardownUnneededNetwork(nai);
    }
}
```

核心子流程：`processDefaultNetworkChanges()` 检测默认网络请求（`mDefaultRequest`）的满足者是否变化。如果变化，调用 `makeDefault()` 完成系统级默认网络切换。

### 4.6 `makeDefault()` 详解

这是默认网络切换的最终执行点：

```java
// ConnectivityService.java (line 12712)
private void makeDefault(@NonNull final NetworkRequestInfo nri,
        @Nullable final NetworkAgentInfo oldDefaultNetwork,
        @Nullable final NetworkAgentInfo newDefaultNetwork) {
    
    // 更新系统默认网络状态
    makeDefaultNetwork(newDefaultNetwork);
    
    // 更新网络活动跟踪
    mNetworkActivityTracker.updateDefaultNetwork(newDefaultNetwork, oldDefaultNetwork);
    
    // 更新TCP缓冲区大小
    updateTcpBufferSizes(newDefaultNetwork.linkProperties.getTcpBufferSizes());
    
    // 通知网络统计服务接口变化
    notifyIfacesChangedForNetworkStats();
    
    // 更新代理设置
    handleApplyDefaultProxy(newDefaultNetwork.linkProperties.getHttpProxy());
}

// 调用 netd 设置系统默认网络
private void makeDefaultNetwork(@Nullable final NetworkAgentInfo newDefaultNetwork) {
    try {
        if (null != newDefaultNetwork) {
            mNetd.networkSetDefault(newDefaultNetwork.network.getNetId());
        } else {
            mNetd.networkClearDefault();
        }
    } catch (RemoteException | ServiceSpecificException e) {
        loge("Exception setting default network :" + e);
    }
}
```

`makeDefault()` 完成以下关键操作：
1. **设置默认网络**：通过 `netd` 将新网络的 netId 设为系统默认
2. **TCP缓冲区**：根据新网络的链路特性调整TCP缓冲区大小
3. **代理设置**：更新HTTP代理配置
4. **接口统计**：通知网络统计服务接口变化

### 4.7 网络切换时序图

```
WiFi NetworkAgent        ConnectivityService       NetworkRanker       netd        Application
       │                         │                       │             │              │
       │ EVENT_NETWORK_CAPS_     │                       │             │              │
       │ CHANGED                 │                       │             │              │
       │────────────────────────>│                       │             │              │
       │                         │ updateCapabilities()  │             │              │
       │                         │ rematchAllNetworks()  │             │              │
       │                         │───────────────────────│             │              │
       │                         │ computeNetworkReassign│             │              │
       │                         │ getBestNetwork()      │             │              │
       │                         │──────────────────────>│             │              │
       │                         │                       │             │              │
       │                         │ getBestNetworkByPolicy │             │              │
       │                         │<──────────────────────│             │              │
       │                         │ return WiFi            │             │              │
       │                         │ applyNetworkReassign() │             │              │
       │                         │ makeDefault()          │             │              │
       │                         │─────────────────────────────────────>│              │
       │                         │ networkSetDefault()    │             │              │
       │                         │                       │             │              │
       │                         │ CALLBACK_AVAILABLE     │             │              │
       │                         │────────────────────────────────────────────────────>│
       │                         │ CALLBACK_LOSING        │             │              │
       │                         │────────────────────────────────────────────────────>│
       │                         │ teardownUnneededNetwork │             │              │
```

## 5 蜂窝与WiFi优先级实现

### 5.1 Transport优先级顺序

当多个网络都满足基本条件（已验证、未退出等）时，`NetworkRanker` 使用传输类型优先级来打破平局：

```java
// NetworkRanker.java (line 123)
private static final int[] PREFERRED_TRANSPORTS_ORDER = { 
    TRANSPORT_ETHERNET,   // 3 - 最高优先级
    TRANSPORT_WIFI,       // 1
    TRANSPORT_BLUETOOTH,  // 2
    TRANSPORT_CELLULAR    // 0 - 最低优先级
};
```

注意：`TRANSPORT_CELLULAR` 的常量为 0，`TRANSPORT_WIFI` 的常量为 1，但优先级顺序是由 `PREFERRED_TRANSPORTS_ORDER` 数组的顺序决定的，而不是常量值。

**关键结论**：在其它条件相同的情况下，**WiFi 优先级高于 Cellular**。

### 5.2 `getBestNetworkByPolicy()` 策略决策链

`NetworkRanker` 使用11步策略链逐级筛选候选网络。前面的步骤优先级更高，一旦某步能将候选网络分为"通过"和"淘汰"两组，就只保留通过组继续下一步筛选。

```java
// NetworkRanker.java (line 230)
@Nullable public <T extends Scoreable> T getBestNetworkByPolicy(
        @NonNull List<T> candidates,
        @Nullable final T currentSatisfier) {
    
    // 阶段1: 无敌网络优先
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_IS_INVINCIBLE), ...);
    
    // 阶段2: VPN优先
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_IS_VPN), ...);
    
    // 阶段3: 用户选择且接受未验证的网络
    partitionInto(candidates, nai -> 
        nai.getScore().hasPolicy(POLICY_EVER_USER_SELECTED)
        && nai.getScore().hasPolicy(POLICY_ACCEPT_UNVALIDATED), ...);
    
    // 阶段4: 已验证网络优先
    partitionInto(candidates, nai -> 
        nai.getScore().hasPolicy(POLICY_IS_VALIDATED)
        || nai.getScore().hasPolicy(POLICY_ACCEPT_UNVALIDATED), ...);
    
    // 阶段4b: Yield to Bad WiFi 策略
    applyYieldToBadWifiPolicy(accepted, rejected);
    
    // 阶段5: 非退出状态网络优先
    partitionInto(candidates, nai -> !nai.getScore().hasPolicy(POLICY_EXITING), ...);
    
    // 阶段6: 主Transport优先
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_TRANSPORT_PRIMARY), ...);
    
    // 阶段7: Transport类型偏好顺序
    for (final int transport : PREFERRED_TRANSPORTS_ORDER) {
        partitionInto(candidates, nai -> nai.getCapsNoCopy().hasTransport(transport), ...);
        if (accepted.size() > 0 && rejected.size() > 0) {
            candidates = new ArrayList<>(accepted);
            break;
        }
    }
    
    // 阶段8: VCN优先
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_VCN), ...);
    
    // 阶段9: 非销毁网络优先
    partitionInto(candidates, nai -> !nai.getScore().hasPolicy(POLICY_IS_DESTROYED), ...);
    
    // 阶段10: 保持当前网络（防止乒乓切换）
    if (candidates.contains(currentSatisfier)) return currentSatisfier;
    
    return candidates.get(0);
}
```

### 5.3 YieldToBadWiFi策略深度解析

这是蜂窝网络让位于WiFi的核心机制。当蜂窝网络被自动赋予 `POLICY_YIELD_TO_BAD_WIFI` 后，即使蜂窝网络当前已验证而WiFi未验证，系统仍可能优先选择WiFi。

**什么是"Bad WiFi"？**

```java
// NetworkRanker.java (line 156)
private <T extends Scoreable> boolean isPreferredBadWiFi(@NonNull final T candidate) {
    final FullScore score = candidate.getScore();
    final NetworkCapabilities caps = candidate.getCapsNoCopy();

    // 必须是WiFi
    if (!caps.hasTransport(TRANSPORT_WIFI)) return false;
    // 当前未验证
    if (score.hasPolicy(POLICY_IS_VALIDATED)) return false;
    // 用户没有明确避免
    if (score.hasPolicy(POLICY_AVOIDED_WHEN_UNVALIDATED)) return false;

    // 配置了 activelyPreferBadWifi 时的逻辑
    if (mConf.activelyPreferBadWifi()) {
        if (!score.hasPolicy(POLICY_EVER_EVALUATED)) return false;
        if (!caps.hasCapability(NET_CAPABILITY_CAPTIVE_PORTAL)) return true;
        return score.hasPolicy(POLICY_EVER_VALIDATED);
    } else {
        // 默认逻辑：曾经验证过即可
        return score.hasPolicy(POLICY_EVER_VALIDATED);
    }
}
```

**Bad WiFi 的判断条件：**
1. 传输类型必须是 WiFi
2. 当前未通过验证（`!POLICY_IS_VALIDATED`）
3. 用户没有明确标记"未验证时避免使用"
4. **曾经验证过**（`POLICY_EVER_VALIDATED`）——这是最关键的条件

**策略应用逻辑：**

```java
// NetworkRanker.java (line 198)
private <T extends Scoreable> void applyYieldToBadWifiPolicy(...) {
    // 检查是否有网络设置了 YIELD_TO_BAD_WIFI
    if (!CollectionUtils.any(accepted, n -> n.getScore().hasPolicy(POLICY_YIELD_TO_BAD_WIFI))) {
        return;
    }
    // 检查是否有"坏WiFi"在拒绝列表中
    if (!CollectionUtils.any(rejected, n -> isPreferredBadWiFi(n))) {
        return;
    }
    
    // 将设置 YIELD_TO_BAD_WIFI 的网络移出 accepted，保留坏WiFi
}
```

**业务含义**：当用户从家中WiFi走到门口，WiFi信号变弱导致验证失败。此时蜂窝网络虽然可用，但由于 ConnectivityService 会自动为蜂窝网络注入 `YIELD_TO_BAD_WIFI`，系统会优先保持WiFi连接（因为"曾经验证过"），而不是立即切换到蜂窝。这避免了在WiFi信号边缘区域频繁来回切换（乒乓效应）。

### 5.4 验证状态对优先级的影响

验证状态是网络优先级决策中最关键的因素之一。`NetworkMonitor` 会定期对新网络进行Internet连通性检测（通常通过访问 `http://connectivitycheck.gstatic.com/generate_204`）。

| 验证状态组合 | WiFi优先级 | 蜂窝优先级 | 结果 |
|------------|-----------|-----------|------|
| WiFi已验证，蜂窝已验证 | `POLICY_IS_VALIDATED` | `POLICY_IS_VALIDATED` | 按Transport顺序：WiFi胜 |
| WiFi已验证，蜂窝未验证 | `POLICY_IS_VALIDATED` | 无 | WiFi胜 |
| WiFi未验证，蜂窝已验证 | 无（或EVER_VALIDATED） | `POLICY_IS_VALIDATED` | 通常蜂窝胜，除非YieldToBadWiFi |
| WiFi未验证，蜂窝未验证 | 无 | 无 | 按Transport顺序或其它策略决定 |

**关键场景：WiFi验证失败时的回退**

当已连接的WiFi突然验证失败（例如路由器断网），`ConnectivityService` 会：
1. 收到 `EVENT_NETWORK_CAPABILITIES_CHANGED`，`NET_CAPABILITY_VALIDATED` 被移除
2. 触发 `rematchAllNetworksAndRequests()`
3. `NetworkRanker` 重新评估：WiFi失去 `POLICY_IS_VALIDATED`
4. 如果蜂窝网络已验证，蜂窝将成为最佳网络
5. 执行切换：蜂窝成为默认网络

### 5.5 未计费网络偏好

WiFi通常被视为不计费网络（`NET_CAPABILITY_NOT_METERED`），而蜂窝数据通常是计费的。虽然在当前 `NetworkRanker` 的实现中，`POLICY_IS_UNMETERED` 没有作为独立的筛选步骤，但这个策略位仍然存在于 `FullScore` 中：

```java
// FullScore.java
POLICY_IS_UNMETERED = 57  // 对应 NET_CAPABILITY_NOT_METERED
```

未来版本中，这个策略位可能被用于更精细的优先级控制。目前，WiFi 作为不计费网络的优势主要通过以下方式体现：
- WiFi 通常是已验证且稳定的，更容易通过前面的策略筛选
- 用户心理上更偏好不计费网络，手动选择WiFi的频率更高

### 5.6 保持当前网络机制

策略链的最后一步是防止不必要的乒乓切换：

```java
// NetworkRanker.java
// 阶段10: 保持当前网络
if (candidates.contains(currentSatisfier)) return currentSatisfier;
```

如果经过前面所有策略筛选后，仍有多个候选网络并列最佳，且当前满足者（`currentSatisfier`）仍在候选列表中，则保持当前网络不变。这确保了：
- 当WiFi和蜂窝都完全相同时（都已验证、都非退出状态），不会发生无意义的切换
- 只有当前网络明显劣于另一个网络时，才会触发切换

## 6 关键源码逐段分析

### 6.1 `NetworkRanker.getBestNetworkByPolicy()` 完整策略链

```java
// NetworkRanker.java (line 230)
@Nullable public <T extends Scoreable> T getBestNetworkByPolicy(
        @NonNull List<T> candidates,
        @Nullable final T currentSatisfier) {
    
    // 阶段1: 无敌网络优先 (POLICY_IS_INVINCIBLE)
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_IS_INVINCIBLE), ...);
    
    // 阶段2: VPN优先 (POLICY_IS_VPN)
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_IS_VPN), ...);
    
    // 阶段3: 用户选择且接受未验证的网络
    partitionInto(candidates, nai -> 
        nai.getScore().hasPolicy(POLICY_EVER_USER_SELECTED)
        && nai.getScore().hasPolicy(POLICY_ACCEPT_UNVALIDATED), ...);
    
    // 阶段4: 已验证网络优先
    partitionInto(candidates, nai -> 
        nai.getScore().hasPolicy(POLICY_IS_VALIDATED)
        || nai.getScore().hasPolicy(POLICY_ACCEPT_UNVALIDATED), ...);
    
    // 阶段4b: Yield to Bad WiFi 策略
    applyYieldToBadWifiPolicy(accepted, rejected);
    
    // 阶段5: 非退出状态网络优先
    partitionInto(candidates, nai -> !nai.getScore().hasPolicy(POLICY_EXITING), ...);
    
    // 阶段6: 主Transport优先
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_TRANSPORT_PRIMARY), ...);
    
    // 阶段7: Transport类型偏好顺序
    for (final int transport : PREFERRED_TRANSPORTS_ORDER) {
        partitionInto(candidates, nai -> nai.getCapsNoCopy().hasTransport(transport), ...);
        if (accepted.size() > 0 && rejected.size() > 0) {
            candidates = new ArrayList<>(accepted);
            break;
        }
    }
    
    // 阶段8: VCN优先 (POLICY_VCN)
    partitionInto(candidates, nai -> nai.getScore().hasPolicy(POLICY_VCN), ...);
    
    // 阶段9: 非销毁网络优先
    partitionInto(candidates, nai -> !nai.getScore().hasPolicy(POLICY_IS_DESTROYED), ...);
    
    // 阶段10: 保持当前网络（防止乒乓切换）
    if (candidates.contains(currentSatisfier)) return currentSatisfier;
    
    return candidates.get(0);
}
```

### 6.2 `FullScore.fromNetworkScore()` 评分构建

```java
// FullScore.java (line 167)
public static FullScore fromNetworkScore(@NonNull final NetworkScore score,
        @NonNull final NetworkCapabilities caps, @NonNull final NetworkAgentConfig config,
        final boolean everValidated, final boolean avoidUnvalidated,
        final boolean yieldToBadWiFi, final boolean everEvaluated, final boolean destroyed) {
    return withPolicies(score.getPolicies(),  // Agent策略位
            score.getKeepConnectedReason(),
            caps.hasCapability(NET_CAPABILITY_VALIDATED),   // 映射为 POLICY_IS_VALIDATED
            everValidated,                                   // POLICY_EVER_VALIDATED
            caps.hasTransport(TRANSPORT_VPN),               // POLICY_IS_VPN
            config.explicitlySelected,                       // POLICY_EVER_USER_SELECTED
            config.acceptUnvalidated,                        // POLICY_ACCEPT_UNVALIDATED
            avoidUnvalidated,                                // POLICY_AVOIDED_WHEN_UNVALIDATED
            caps.hasCapability(NET_CAPABILITY_NOT_METERED), // POLICY_IS_UNMETERED
            yieldToBadWiFi,
            false /* invincible */,
            everEvaluated,                                   // POLICY_EVER_EVALUATED
            destroyed);                                      // POLICY_IS_DESTROYED
}
```

### 6.3 `ConnectivityService.computeNetworkReassignment()` 计算逻辑

```java
// ConnectivityService.java (line 13048)
private NetworkReassignment computeNetworkReassignment(
        @NonNull final Collection<NetworkRequestInfo> networkRequests) {
    final NetworkReassignment changes = new NetworkReassignment();
    
    for (final NetworkRequestInfo nri : networkRequests) {
        for (final NetworkRequest req : nri.mRequests) {
            // 核心：调用NetworkRanker选出最佳网络
            final NetworkAgentInfo bestNetwork = 
                mNetworkRanker.getBestNetwork(req, nais, nri.getSatisfier());
            
            if (nri.getSatisfier() != bestNetwork) {
                changes.addRequestReassignment(nri, bestNetwork);
            }
        }
    }
    return changes;
}
```

### 6.4 `ConnectivityService.makeDefault()` 默认网络切换

```java
// ConnectivityService.java (line 12712)
private void makeDefault(@NonNull final NetworkRequestInfo nri,
        @Nullable final NetworkAgentInfo oldDefaultNetwork,
        @Nullable final NetworkAgentInfo newDefaultNetwork) {
    
    makeDefaultNetwork(newDefaultNetwork);
    mNetworkActivityTracker.updateDefaultNetwork(newDefaultNetwork, oldDefaultNetwork);
    updateTcpBufferSizes(newDefaultNetwork.linkProperties.getTcpBufferSizes());
    notifyIfacesChangedForNetworkStats();
}

private void makeDefaultNetwork(@Nullable final NetworkAgentInfo newDefaultNetwork) {
    try {
        if (null != newDefaultNetwork) {
            mNetd.networkSetDefault(newDefaultNetwork.network.getNetId());
        } else {
            mNetd.networkClearDefault();
        }
    } catch (RemoteException | ServiceSpecificException e) {
        loge("Exception setting default network :" + e);
    }
}
```

### 6.5 `NetworkRanker.isPreferredBadWiFi()` 坏WiFi判断

```java
// NetworkRanker.java (line 156)
private <T extends Scoreable> boolean isPreferredBadWiFi(@NonNull final T candidate) {
    final FullScore score = candidate.getScore();
    final NetworkCapabilities caps = candidate.getCapsNoCopy();

    if (!caps.hasTransport(TRANSPORT_WIFI)) return false;
    if (score.hasPolicy(POLICY_IS_VALIDATED)) return false;
    if (score.hasPolicy(POLICY_AVOIDED_WHEN_UNVALIDATED)) return false;

    if (mConf.activelyPreferBadWifi()) {
        if (!score.hasPolicy(POLICY_EVER_EVALUATED)) return false;
        if (!caps.hasCapability(NET_CAPABILITY_CAPTIVE_PORTAL)) return true;
        return score.hasPolicy(POLICY_EVER_VALIDATED);
    } else {
        return score.hasPolicy(POLICY_EVER_VALIDATED);
    }
}
```

### 6.6 `TelephonyNetworkAgent` 构造函数与评分设置

```java
// TelephonyNetworkAgent.java
public TelephonyNetworkAgent(@NonNull Phone phone, @NonNull Looper looper,
        @NonNull DataNetwork dataNetwork, @NonNull NetworkScore score,
        @NonNull NetworkAgentConfig config, @NonNull NetworkProvider provider,
        @NonNull TelephonyNetworkAgentCallback callback) {
    super(phone.getContext(), looper, "TelephonyNetworkAgent",
            new NetworkCapabilities.Builder(dataNetwork.getNetworkCapabilities())
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED)
                    .build(),
            dataNetwork.getLinkProperties(), score, config, provider);
    register();
}
```

`TelephonyNetworkAgent` 由 `DataNetwork` 创建（不是 `DataNetworkController`）。`DataNetwork` 构建的 `NetworkScore` 只设置了 `TRANSPORT_PRIMARY` 和 `KEEP_CONNECTED_REASON`，**并未设置 `POLICY_YIELD_TO_BAD_WIFI`**。

`POLICY_YIELD_TO_BAD_WIFI` 的实际注入点在 `ConnectivityService` 端的 `NetworkAgentInfo` 中：

```java
// NetworkAgentInfo.java (line 1134)
private boolean yieldToBadWiFi() {
    // Only cellular networks yield to bad wifi
    return networkCapabilities.hasTransport(TRANSPORT_CELLULAR)
            && !mConnService.avoidBadWifi();
}
```

当 `NetworkAgentInfo.setScore()` 或 `updateScoreForNetworkAgentUpdate()` 被调用时，会将 `yieldToBadWiFi()` 的计算结果传入 `FullScore.fromNetworkScore()`，从而动态决定是否为蜂窝网络注入 `POLICY_YIELD_TO_BAD_WIFI`。

## 7 验证与测试方法

### 7.1 源码对照验证

对文档中引用的每个代码片段，应回到原始文件核对行号和内容。关键文件清单：

| 文件 | 验证重点 |
|------|---------|
| `ConnectivityService.java` | 切换流程方法（rematch/compute/apply/makeDefault） |
| `NetworkRanker.java` | 排名逻辑（PREFERRED_TRANSPORTS_ORDER、getBestNetworkByPolicy） |
| `FullScore.java` | 评分构建（fromNetworkScore、策略位常量） |
| `NetworkScore.java` | Agent策略位定义 |
| `NetworkCapabilities.java` | Transport和Capability常量 |

### 7.2 AOSP编译验证

确保引用的类和方法在AOSP编译树中实际存在且可编译：

```bash
# 编译 Connectivity 模块
m Connectivity

# 编译 Telephony 模块  
m Telephony
```

### 7.3 运行时日志验证

在Android设备上通过logcat观察实际切换行为：

```bash
adb logcat -s ConnectivityService NetworkRanker *:S
```

关键日志格式：
```
Rematched networks [computed Xms] [applied Yms]
Switching to new default network for: ...
```

### 7.4 单元测试验证

相关测试文件位置：
- `Connectivity/tests/unit/java/com/android/server/NetworkRankerTest.java`
- `Connectivity/tests/unit/java/com/android/server/ConnectivityServiceTest.java`

运行现有单元测试，确认文档描述与测试用例一致：

```bash
atest NetworkRankerTest
atest ConnectivityServiceTest
```

## 8 总结与最佳实践

### 8.1 WiFi优先于蜂窝数据的多层机制

Android通过 **5层机制** 确保WiFi优先于蜂窝数据：

| 层级 | 机制 | 实现位置 | 说明 |
|------|------|---------|------|
| 1 | Transport顺序偏好 | `NetworkRanker.PREFERRED_TRANSPORTS_ORDER` | ETHERNET > WIFI > BLUETOOTH > CELLULAR |
| 2 | 验证状态权重 | `POLICY_IS_VALIDATED` | 已验证的WiFi > 未验证的蜂窝 |
| 3 | Yield to Bad WiFi | `POLICY_YIELD_TO_BAD_WIFI` | 蜂窝让位于曾经验证过的WiFi |
| 4 | 未计费网络标识 | `POLICY_IS_UNMETERED` | WiFi通常不计费（未来可能启用优先） |
| 5 | 保持当前网络 | `currentSatisfier` 检查 | 避免无意义的乒乓切换 |

### 8.2 网络切换核心流程回顾

```
触发条件（6类）
    ↓
rematchAllNetworksAndRequests() —— 入口
    ↓
computeNetworkReassignment() —— 决策
    ├── 收集候选网络
    ├── NetworkRanker.getBestNetworkByPolicy() —— 11步策略链
    └── 记录变化到 NetworkReassignment
    ↓
applyNetworkReassignment() —— 执行
    ├── updateSatisfiersForRematchRequest()
    ├── processDefaultNetworkChanges()
    │   └── makeDefault() → netd.networkSetDefault()
    ├── 发送回调通知 (onAvailable/onLost)
    └── teardownUnneededNetwork()
    ↓
issueNetworkNeeds() —— 发布需求
```

### 8.3 NetworkScore策略位图的设计优势

1. **可扩展性**：新增优先级维度只需增加一个策略位，无需修改排名算法
2. **优先级明确**：策略链的顺序严格定义了各条件的优先级，不会产生歧义
3. **调试友好**：每个策略位有明确的语义，便于日志分析和问题定位
4. **向后兼容**：保留 `mLegacyInt` 字段，兼容旧版API

### 8.4 开发建议

**调试网络切换问题：**
- 开启 `ConnectivityService` 和 `NetworkRanker` 的详细日志
- 关注 `Rematched networks` 日志，查看compute/apply耗时
- 检查 `Switching to new default network` 日志，确认切换原因

**新增自定义策略位：**
- 在 `NetworkScore.java` 中定义新的 Agent 策略位（0-31范围）
- 或在 `FullScore.java` 中定义新的 CS 策略位（54-63范围）
- 在 `NetworkRanker.getBestNetworkByPolicy()` 中添加对应的筛选步骤

**Telephony模块设置NetworkScore：**
- `DataNetwork` 创建 `TelephonyNetworkAgent` 时构建 `NetworkScore`，只需设置 `TRANSPORT_PRIMARY` 和 `KEEP_CONNECTED_REASON`
- `POLICY_YIELD_TO_BAD_WIFI` 由 `ConnectivityService` 端根据网络类型自动注入，无需 Telephony 模块设置
- 网络即将断开前设置 `POLICY_EXITING`，避免被选为默认网络
- 根据数据计划类型正确设置 `NET_CAPABILITY_NOT_METERED`
