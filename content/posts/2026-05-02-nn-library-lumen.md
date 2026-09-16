---
title: 如何编写神经网络库：以 Lumen 为例
date: 2026-05-02 22:05
updated: 2026-05-02 22:05
tags: [深度学习, 神经网络, Rust]
categories: 技术
---

本人的神经网络库（可否点个star）：

[https://github.com/chen-197/Lumen](https://github.com/chen-197/Lumen)

  

很多人第一次接触神经网络库，是从几行几乎没有重量的代码开始的：

```text
optimizer.zero_grad()
logits = model(input)
loss = criterion(logits, target)
loss.backward()
optimizer.step()
```

5行而已。门外是数据集、模型结构、loss 曲线和 benchmark 数字；门内却是另一套更隐蔽的世界：Tensor 的生命周期、计算图的生长、梯度的回流、dtype 与 device 的分工、CPU 与 CUDA 的边界，以及无数隐藏在一次 `forward` 背后的工程选择。

如果把神经网络库看成一座城市，Tensor 是街道，算子是车辆，自动求导是交通规则，Module 是建筑群，Optimizer 则像每天夜里悄悄修整城市的人。使用者通常只看到城市的灯火，却很少看到地下管线如何铺设。

Lumen 正好适合作为观察这座城市如何建成的例子。它不是一个试图复刻 PyTorch 全部能力的庞大框架，而是一个 Rust\-first 的小型深度学习核心：有动态自动求导，有 Module 和 Layer，有 Loss 与 Optimizer，有 dtype 管理，有 safetensors 加载，也有 CPU/CUDA 推理路径和 Llama 风格模型运行时。

更准确地说，Lumen 是一个“足够完整，但没有大到看不清”的样本。它让我们可以沿着一条清晰的路线观察：一个神经网络库如何从一个 Tensor 开始，最终长成可以运行 Llama-style decoder 的系统。

这篇文章不想把“如何编写神经网络库”写成一份冷冰冰的清单。我们从一个问题开始：当你写下 `loss.backward()` 的时候，库到底替你做了什么？

* * *

### 1\. 先看整体地图：神经网络库到底由什么组成

很多人会把神经网络库想成“矩阵乘法 + 激活函数”。这个理解不算错，但太薄了。矩阵乘法只是城市里最繁忙的路口，不是城市本身。

一个可训练、可推理、可扩展的神经网络库，至少要有这些层次：

```text
Tensor / Storage / Device
        ↓
Autograd / Dynamic Graph
        ↓
Ops / Kernels / Dispatch
        ↓
Layers / Module
        ↓
Loss / Optimizer
        ↓
Model
        ↓
Loader / Tokenizer / Runtime
        ↓
Benchmark / Test / Backend Optimization
```

Lumen 的源码结构刚好能对应这张地图：

```text
src/
├─ autograd.rs              # Tensor + dynamic autograd core
├─ module.rs                # Module trait / Sequential / parameter management
├─ precision.rs             # DType and runtime precision policy
├─ ops/                     # Tensor ops, CPU kernels, optional CUDA wrappers
│  └─ cuda/lumen_cuda.cu    # CUDA/cuBLAS/cuDNN/custom kernels
├─ layers/                  # Linear, Embedding, RMSNorm, SelfAttention, activations...
├─ models/llama.rs          # Llama-style decoder implementation
├─ loss.rs                  # MSE / cross entropy and related backward paths
├─ optim.rs                 # Optimizers such as SGD / Adam
├─ loader.rs                # safetensors loading and streamed loading
├─ tokenizer.rs             # Hugging Face tokenizer wrapper
└─ bin/                     # quantization and benchmark tools
```

这个结构像一棵树。树根是 Tensor，树干是 autograd 和 ops，树枝是 layers 与 models，叶子是训练、推理、量化、benchmark 等具体任务。

写神经网络库最忌讳一开始就扎进某个 kernel 里。kernel 当然重要，但如果 Tensor、dtype、device、autograd 的边界没有想清楚，后面每做一次优化都会牵一发动全身。Lumen 的代码很有代表性：它没有把所有东西堆在一个文件里，而是把“数学抽象”和“执行路径”拆开，让系统可以逐层生长。

* * *

### 2\. Tensor 不是数组，而是带着历史的对象

最容易被低估的是 Tensor。

很多人第一次理解 Tensor，会把它看成“更高维的数组”。比如在 PyTorch 里，一张图片 batch 通常可以表示成四维张量：

$$X \\in \\mathbb{R}^{B \\times C \\times H \\times W}$$

其中 $B$ 是 batch size，$C$ 是通道数，$H$ 和 $W$ 是图像高度与宽度。而在 Transformer 或语言模型里，中间激活常常写成：

$$X \\in \\mathbb{R}^{B \\times S \\times H}$$

其中 $B$ 是 batch size，$S$ 是序列长度，$H$ 是 hidden size。

从这个角度看，Tensor 似乎只是一个多维数组：二维是矩阵，三维是序列特征，四维是图像 batch，再往上也不过是更多维度的排列。

但对一个神经网络库来说，Tensor 不能只是数据本身。它还必须知道自己在哪里、以什么精度存储、是否需要梯度、由哪些父节点计算而来，以及反向传播时应该如何把梯度送回去。

也就是说，在 PyTorch 用户眼里，Tensor 往往是一个可以参与计算的多维数组；而在神经网络库实现者眼里，Tensor 更像是一个带状态的计算图节点。它既保存数据，也保存这份数据在一次计算中留下的历史。

在 Lumen 中，Tensor 的核心数据结构位于 `src/autograd.rs`。删去部分辅助逻辑后，它大致可以概括为：

```text
pub struct TensorData {
    pub data: ArcArray<f32, IxDyn>,
    pub f16_data: Option<ArcArray<f16, IxDyn>>,
    pub bf16_data: Option<ArcArray<bf16, IxDyn>>,
    pub i8_data: Option<ArcArray<i8, IxDyn>>,
    pub cuda_f32_data: Option<CudaBuffer>,

    pub i8_scale: Option<f32>,
    pub has_f32_data: bool,
    pub storage_dtype: DType,
    pub cache_dirty: bool,
    pub is_parameter: bool,

    pub grad: Option<ArcArray<f32, IxDyn>>,
    pub cuda_f32_grad: Option<CudaBuffer>,

    pub parents: Vec<Tensor>,
    pub backward_op: Option<Rc<dyn Fn(&ArrayViewD<f32>)>>,
    pub requires_grad: bool,
    pub device: Device,
}
```

这段结构很能说明问题：Tensor 不是一个“值”，而是一个带着历史、位置和策略的对象。

它有 f32 数据，也可能有 f16、bf16、i8 数据；它可以在 CPU 上，也可以在 CUDA 上；它可以是普通中间结果，也可以是参数；它可以有梯度，也可以没有梯度；它可以是计算图里的节点，也可以只是推理时的一块缓存。

如果写一个玩具库，只保存 `ArrayD<f32>` 当然可以跑一些前向计算。但一旦要训练模型，事情立刻变复杂。假设有：

$$y = xW^T + b$$

如果最后的 loss 是 $L$，反向传播时就需要：

$$\\frac{\\partial L}{\\partial x}, \\quad \\frac{\\partial L}{\\partial W}, \\quad \\frac{\\partial L}{\\partial b}$$

这些梯度不会凭空出现。库必须在前向计算时就埋下线索：这个 $y$ 来自 $x$、$W$ 和 $b$，对应的反向传播规则是什么。

这就是 Tensor 真正承担的角色：它既是数据容器，也是计算图节点。

* * *

### 3\. Rust 里的 Tensor：共享、可变和生命周期

在 Python 里写动态图，很多复杂性被解释器和 GC 藏起来了。但在 Rust 里，Tensor 的设计会更早暴露一个问题：计算图是共享结构，而梯度又需要可变累加。

Lumen 的 Tensor 外壳是：

```text
#[derive(Clone)]
pub struct Tensor(pub(crate) Rc<RefCell<TensorData>>);
```

这行代码背后有两个选择。

`Rc` 负责共享所有权。一个 Tensor 可以被多个后续节点引用，例如：

```text
      x
     / \
    a   b
     \ /
      y
```

如果没有共享所有权，动态图会很难表达。每个节点都可能成为多个后续运算的父节点。

`RefCell` 负责内部可变性。梯度是在 backward 过程中逐步累加的。前向计算结束时，某个 Tensor 的数据结构已经存在；反向传播时，我们需要往它的 `grad` 字段里写东西。如果完全依赖 Rust 的静态借用规则，动态图这种结构会非常不方便。

所以 `Rc<RefCell<TensorData>>` 是一种现实的动态图实现方式：它放弃了一部分编译期约束，换来了动态图需要的共享与可变能力。

在 Lumen 当前的设计里，并行主要发生在**算子内部**，而不是发生在动态图节点本身。矩阵乘、matvec、softmax、RMSNorm 这类计算热点，可以交给 Rayon CPU kernel、SIMD 路径、CUDA kernel 或 cuBLAS 去并行执行；动态图控制层则负责记录“这个 Tensor 从哪里来、反向时怎么回去、梯度应该累加到哪里”。换句话说，算子内部承担 compute plane，`Rc<RefCell<_>>` 管理 graph control plane。

这种边界符合当前单机、单节点场景下的需求：真正耗时的是算子计算，而不是 Tensor 节点的所有权管理。既然算子内并行已经覆盖了主要性能瓶颈，再把高层动态图节点也设计成高度并发共享对象，往往会变成过度并行。它会让每次访问 TensorData 都附带更多同步成本，却未必能让矩阵乘、attention 或 decode 热路径变得更快。

这并不是说 `Rc<RefCell<_>>` 没有代价。`RefCell` 的借用检查发生在运行时，错误使用会 panic；`Rc` 也不允许 Tensor 节点直接跨线程共享。但换成 `Arc<Mutex<_>>` 也不等于系统就自然获得了更好的并行能力。它只是允许多个 host 线程共享同一个 `TensorData` 并通过锁互斥访问，随之而来的可能是更高的访问成本、锁竞争、反向传播中的锁顺序问题，以及梯度累加被锁串行化。

如果未来要支持多节点 autograd，真正需要设计的是任务调度、依赖计数、梯度累加策略、图生命周期和设备同步边界；如果未来要支持多节点训练，问题就更不是一个 `Arc<Mutex<_>>` 能解决的。多节点场景首先要回答的是：每个节点是否各自持有完整权重，走数据并行并通过 all-reduce 同步梯度？还是把权重、激活或 attention head 切开，让不同节点各自持有模型的一部分，走张量并行、流水并行或参数分片？不同答案会导向完全不同的通信、存储和调度结构。

所以这里的取舍不是“`Rc<RefCell<_>>` 低级，`Arc<Mutex<_>>` 高级”，而是：在当前单机/单节点的动态图控制结构中，轻量的共享可变对象已经足够；需要并行的重计算交给算子内部和后端 kernel。等系统走向多线程图执行或多节点训练时，应该重新设计执行器和分布式边界，而不是只替换智能指针。

* * *

### 4\. 动态计算图：让运算留下脚印

神经网络库有两种常见思路：一种是静态图，先把图搭好，再执行；另一种是动态图，代码执行到哪里，图就生长到哪里。

Lumen 选择的是动态图。它的气质更接近 PyTorch：每次执行一个 Tensor 运算，如果当前不是 `no_grad` 或 inference mode，并且输入需要梯度，那么结果 Tensor 就会记录自己的父节点和反向函数。

比如：

```text
let z = x.matmul(&w).add(&b);
```

背后会长出一棵小图：

```text
z
└─ add
   ├─ matmul
   │  ├─ x
   │  └─ w
   └─ b
```

真正的魔法发生在 `backward()`。从数学上说，反向传播就是链式法则：

$$\\frac{\\partial L}{\\partial x} = \\frac{\\partial L}{\\partial f} \\cdot \\frac{\\partial f}{\\partial x}$$

从工程上说，反向传播是一次反向遍历。

Lumen 的 `Tensor::backward()` 思路很清晰：

```text
pub fn backward(&self) {
    let mut topo = Vec::new();
    let mut visited = HashSet::new();

    fn build_topo(node: &Tensor, topo: &mut Vec<Tensor>, visited: &mut HashSet<*const TensorData>) {
        let ptr = node.0.as_ptr() as *const TensorData;
        if visited.contains(&ptr) {
            return;
        }
        visited.insert(ptr);

        for parent in &node.0.borrow().parents {
            build_topo(parent, topo, visited);
        }
        topo.push(node.clone());
    }

    build_topo(self, &mut topo, &mut visited);

    // 如果输出还没有梯度，就按输出形状生成全 1 梯度种子
    // 然后按 topo 的反序依次执行 backward_op
}
```

这段代码像一次逆流而上的旅行。

前向传播时，每个算子都在图上留下脚印；反向传播时，库先从输出节点向上游收集所有节点，得到拓扑序，然后反向执行每个节点保存的 `backward_op`。

如果结果节点还没有梯度，Lumen 会按结果 Tensor 的逻辑 shape 播下一块全 1 梯度。对最常见的标量 loss 来说，这个种子就是：

$$\\frac{\\partial L}{\\partial L} = 1$$

实现上则更一般，它会按照输出 Tensor 的形状生成全 1 梯度。这样既覆盖最常见的标量 loss，也能支持对非标量 Tensor 显式调用 `backward()` 的场景。

随后，梯度开始向父节点流动。每经过一个算子，就根据该算子的局部导数改变形态，最后回到参数。

这个过程很像河流系统。loss 是下游，参数是上游。forward 时水从上游流向下游；backward 时我们沿着河道追踪每一滴水的来源。

* * *

### 5\. 算子：每一个数学符号都要落成程序

有了 Tensor 和动态图，下一步就是算子。

一个神经网络库里的算子，远不止“把两个数组相加”这么简单。以矩阵乘为例：

$$C = AB$$

它至少要处理这些问题：

```text
shape 是否合法？
dtype 是 f32、f16、bf16，还是 i8？
Tensor 在 CPU 还是 CUDA？
当前是否需要构建计算图？
是否允许 fallback？
反向传播公式是什么？
梯度 shape 是否需要还原？
```

矩阵乘的反向公式很漂亮：

$$\\frac{\\partial L}{\\partial A} = \\frac{\\partial L}{\\partial C}B^T$$

$$\\frac{\\partial L}{\\partial B} = A^T\\frac{\\partial L}{\\partial C}$$

但代码里不会只有这两行。它会展开成 device 检查、dtype dispatch、CUDA wrapper、shape reshape、梯度累加、内存复用和 fallback 策略。

Lumen 的算子系统集中在 `src/ops/`：

```text
src/ops/
├─ arithmetic.rs
├─ matmul.rs
├─ shape.rs
├─ convolution.rs
├─ fused.rs
├─ fp_kernels.rs
├─ int8_kernels.rs
├─ cuda.rs
└─ cuda/lumen_cuda.cu
```

这里已经能看出一个库从“能算”走向“能用”的过程。

`arithmetic.rs` 负责加减乘除这类基础逐元素运算；`shape.rs` 处理 reshape、transpose、slice、cat 等结构变化；`matmul.rs` 是矩阵乘和 matvec 的主战场；`fused.rs` 则开始进入性能优化区域，把多个常见操作合并成更紧凑的执行路径。

一个有趣的分界线是：高层 API 不应该让用户感觉到 CUDA 的存在，但底层实现必须时刻知道 CUDA 的存在。

更合理的结构是：

```text
Tensor API
    ↓
ops::matmul / ops::arithmetic / ops::shape
    ↓
CPU path or CUDA path
    ↓
Rayon / SIMD / cuBLAS / cuDNN / custom CUDA kernels
```

用户调用的仍然是 `matmul`，但库内部会根据 device、dtype、当前模式选择不同路径。这就是神经网络库工程化的核心之一：数学接口保持稳定，执行路径不断演化。

* * *

### 6\. Shape 运算：看似无害，却最容易让梯度出错

很多初学者写神经网络库时，会把注意力放在矩阵乘和卷积上，低估 shape 运算。实际上，reshape、transpose、slice、cat、broadcast 这类操作特别容易藏 bug。

原因是它们的前向计算看起来没什么数学含量，但反向传播必须小心地把梯度变回原来的形状。

比如 reshape：

$$y = \\operatorname{reshape}(x)$$

前向只是重新解释形状，反向时则要把梯度 reshape 回去：

$$\\frac{\\partial L}{\\partial x} = \\operatorname{reshape}\\left(\\frac{\\partial L}{\\partial y}, \\operatorname{shape}(x)\\right)$$

再比如 broadcast。如果某个维度是广播出来的，反向传播时就要沿着对应维度求和，把梯度压回原 shape。

这类操作不炫技，但它们决定了整个自动求导系统是否可靠。一个 matmul 的梯度公式写对了，但 broadcast 的梯度还原写错了，训练照样会悄悄跑偏。

所以一个神经网络库的 `shape.rs` 往往比它看起来更重要。它不是工具箱边角料，而是计算图能够稳定变形的骨架。

* * *

### 7\. Module：把零散 Tensor 运算组织成模型

如果只有 Tensor 和 ops，写神经网络会像手工焊电路：每个权重、每个 bias、每个 forward 都要自己接线。

真正的模型需要一个更高层的抽象，也就是 Module。

Lumen 的 `Module` trait 位于 `src/module.rs`，核心接口很简单：

```text
pub trait Module {
    fn forward(&self, input: Tensor) -> Tensor;
    fn parameters(&self) -> Vec<Tensor>;
}
```

这两个函数足够把很多东西串起来。

`forward` 定义计算；`parameters` 定义哪些 Tensor 是可训练参数。Optimizer 并不需要理解 Linear、Embedding、Attention 的内部结构，它只要拿到参数列表就可以更新。

Lumen 的 `Module` 还提供了更多工程接口：

```text
fn train_mode(&mut self);
fn eval_mode(&mut self);
fn save(&self, path: &str) -> std::io::Result<()>;
fn load(&self, path: &str) -> std::io::Result<()>;
fn cast_parameters(&self, dtype: DType);
fn quantize_parameters(&self, dtype: DType);
fn dequantize_parameters(&self, dtype: DType);
fn to_device(&self, device: Device);
fn to_cpu(&self);
fn to_cuda(&self);
```

这说明 Module 不是一个简单的“函数对象”。它是参数管理、保存加载、精度转换、设备迁移的统一入口。

比如一个 Linear 层，本质上是：

$$Y = XW^T + b$$

在 Lumen 里，Linear 的权重布局是 `[out_features, in_features]`，这与 PyTorch/Hugging Face 的 `nn.Linear.weight` 布局保持一致：

```text
pub struct Linear {
    pub weight: Tensor,       // shape: [out_features, in_features]
    pub bias: Option<Tensor>, // shape: [out_features]
    pub in_features: usize,
    pub out_features: usize,
}
```

这是一种非常关键的转变：库不再只是“执行单个数学运算”，而是开始描述“可组合的神经网络部件”。

从这里开始，神经网络库的世界会变得更像搭积木。Linear、Embedding、RMSNorm、SelfAttention、MLP 都是积木；LlamaModel 只是把这些积木按一定结构堆起来。

* * *

### 8\. Linear 层的两个面孔：训练路径与推理热路径

Linear 是神经网络里最朴素的层，却也是最能暴露库设计水平的层。

训练时，Linear 需要保持可导。它可以走通用的 `matmul` 路径，让 autograd 记录父节点和反向传播函数。推理时，尤其是 decode 阶段，情况完全不同。

Lumen 的 `Linear::forward()` 大体是这样的：

```text
impl Module for Linear {
    fn forward(&self, input: Tensor) -> Tensor {
        let y = matmul(&input, &self.weight);

        if let Some(bias) = &self.bias {
            if is_no_grad() {
                // no_grad / inference 下直接把 bias 加到输出数据里，避免构建额外 add 节点
                add_bias_into_last_axis(&y, bias);
                y
            } else {
                // training 下走 Tensor add，这样 bias 也能成为计算图里的父节点
                y + bias.clone()
            }
        } else {
            y
        }
    }
}
```

这里的重点不是“有没有 bias”，而是同一个语义在不同模式下走不同路径：训练路径要保留计算图；推理路径则尽量减少图节点和中间分配。

自回归生成每次只处理一个新 token。此时很多大矩阵乘会退化成 matvec。Lumen 在 Linear 里专门提供了 `forward_decode_slice_no_bias_into` 这类函数，用输入 slice 和输出 buffer 直接走推理热路径，避免额外 Tensor 包装和中间分配。

这类函数通常不会出现在“最小神经网络库”教程里，但它们会出现在真实 runtime 里。因为 decode 的速度往往就卡在这些地方：一个 token、一个 token 地生成，每一步开销都会被放大。

更有意思的是 i8 权重路径。Lumen 会根据参数 dtype 和 `allow_parameter_dtype_copies` 决定是否直接使用 i8 native storage 进行 mixed matvec。这里的选择体现了一个很现实的问题：

```text
权重用 i8 存，是否每次都转回 f32 算？
保留 f32 cache 会更快，但更占内存。
直接用 i8 算更省内存，但 kernel 要更仔细。
```

这就是神经网络库的日常：一个看起来简单的 Linear 层，里面同时住着训练图、推理热路径、量化权重、内存策略和 dtype policy。

* * *

### 9\. Loss 与 Optimizer：训练闭环终于合上

一个库只有 forward，还不能叫训练框架。它必须有 loss，也必须有 optimizer。

以均方误差为例：

$$L = \\frac{1}{n}\\sum\_{i=1}^{n}(\\hat{y}\_i - y\_i)^2$$

它的梯度是：

$$\\frac{\\partial L}{\\partial \\hat{y}\_i} = \\frac{2}{n}(\\hat{y}\_i - y\_i)$$

这类 loss 适合观察自动求导是否正确，因为公式直观，梯度也容易验证。

分类任务常用交叉熵。先经过 softmax：

$$p\_i = \\frac{e^{z\_i}}{\\sum\_j e^{z\_j}}$$

再计算：

$$L = -\\sum\_i y\_i \\log p\_i$$

如果 $y$ 是 one-hot 标签，那么 softmax + cross entropy 的梯度可以写得很漂亮：

$$\\frac{\\partial L}{\\partial z\_i} = p\_i - y\_i$$

Lumen 的 `src/loss.rs` 中实现了 MSELoss 和 CrossEntropyLoss，并且为 CUDA 路径准备了 forward/backward 分支。一个成熟的 loss 实现不仅要给出数值，还要在反向传播里把梯度送回 logits。

Optimizer 则负责参数更新。最朴素的是 SGD：

$$\\theta\_{t+1} = \\theta\_t - \\eta \\nabla\_\\theta L$$

Adam 稍微复杂一些。它维护一阶矩和二阶矩：

$$m\_t = \\beta\_1 m\_{t-1} + (1-\\beta\_1)g\_t$$

$$v\_t = \\beta\_2 v\_{t-1} + (1-\\beta\_2)g\_t^2$$

再做 bias correction：

$$\\hat{m}\_t = \\frac{m\_t}{1-\\beta\_1^t}, \\quad \\hat{v}\_t = \\frac{v\_t}{1-\\beta\_2^t}$$

最后更新参数：

$$\\theta\_t = \\theta\_{t-1} - \\eta \\frac{\\hat{m}\_t}{\\sqrt{\\hat{v}\_t}+\\epsilon}$$

Lumen 的 `src/optim.rs` 中有 Adam 实现。它维护：

```text
pub struct Adam {
    params: Vec<Tensor>,
    lr: f32,
    betas: (f32, f32),
    eps: f32,
    step_count: usize,
    state_dtype: DType,
    exp_avg: Vec<Option<Tensor>>,    // m
    exp_avg_sq: Vec<Option<Tensor>>, // v
}
```

这里的 `state_dtype` 很值得注意。Optimizer state 不一定要和参数 dtype 完全相同。参数可以为了节省内存用 bf16，梯度可以为了稳定保留 f32，optimizer state 也可以根据速度和内存选择 f32、f16 或 bf16。

到这里，一个最小训练循环终于闭合了：

```text
for batch in data {
    let pred = model.forward(x);
    let loss = MSELoss::apply(&pred, &y);

    optimizer.zero_grad();
    loss.backward();
    optimizer.step();
}
```

它看起来短，但这几行背后已经串起了 Tensor、动态图、算子、Module、Loss 和 Optimizer。

* * *

### 10\. 精度系统：f32、f16、bf16、i8 不是换个名字那么简单

很多人写第一个神经网络库时，会先把所有东西都做成 f32。这当然合理，因为 f32 最容易保证正确性。但一旦进入大模型推理，f32 很快会显得笨重。

现代神经网络库通常需要同时支持：

```text
f32  : 稳定，适合基准实现和部分训练状态
f16  : 节省内存和带宽，GPU 上常见
bf16 : 动态范围更接近 f32，训练和推理都常见
i8   : 适合量化权重，降低模型体积和带宽压力
```

Lumen 的 `src/precision.rs` 明确把 dtype 管理抽成一套系统：

```text
pub enum DType {
    F32 = 0,
    F16 = 1,
    BF16 = 2,
    I8 = 3,
}

pub struct PrecisionConfig {
    pub parameter_dtype: DType,
    pub runtime_dtype: DType,
    pub allow_parameter_dtype_copies: bool,
}
```

除了参数 dtype 和 runtime dtype，Lumen 还维护 activation dtype、KV cache dtype、parameter quantization，以及它们是否跟随 runtime dtype 的策略。

这一点和 Tensor 里的字段是对应的：

```text
pub data: ArcArray<f32, IxDyn>,
pub f16_data: Option<ArcArray<f16, IxDyn>>,
pub bf16_data: Option<ArcArray<bf16, IxDyn>>,
pub i8_data: Option<ArcArray<i8, IxDyn>>,
pub grad: Option<ArcArray<f32, IxDyn>>,
```

这说明 Lumen 并没有把“Tensor 的 dtype”简单理解成一个标签。它更像在维护几种可能的存储形态，并根据当前执行路径选择合适的表示。

量化可以用一个简化公式理解：

$$q = \\operatorname{round}\\left(\\frac{x}{s}\\right)$$

$$x \\approx s \\cdot q$$

其中 $s$ 是 scale，$q$ 是 i8 存储的整数值。

这里有一个很容易踩坑的点：参数是 bf16 或 i8，并不意味着梯度也应该是 bf16 或 i8。

在 Lumen 的设计里，`grad` 仍然是 `Option<ArcArray<f32, IxDyn>>`。这背后的逻辑很朴素：参数存储关心内存和带宽，梯度与优化器状态关心数值稳定性。把它们强行绑定，通常只会让训练更脆弱。

更合理的拆法是：

```text
parameter dtype  : 权重怎么存
runtime dtype    : 算子主要按什么精度跑
activation dtype : 中间激活怎么存
kv-cache dtype   : 推理缓存怎么存
grad dtype       : 梯度怎么累加
optimizer dtype  : 优化器状态怎么保存
```

这不是为了复杂而复杂，而是大模型时代的现实：性能从来不是一个开关，而是一组互相牵制的选择。

* * *

### 11\. no\_grad、inference mode 与 strict device：库里的“交通灯”

神经网络库里有一些开关，看起来不起眼，却决定了系统在不同场景下如何行驶。

Lumen 里有 `no_grad` 和 inference mode：

```text
pub fn set_inference_mode(on: bool);
pub fn is_inference_mode() -> bool;
pub fn is_no_grad() -> bool;
pub fn no_grad<R>(f: impl FnOnce() -> R) -> R;
```

`is_no_grad()` 的逻辑是：只要当前在 `NoGradGuard` 作用域内，或者处于 inference mode，就不构建梯度图。

这很重要。推理时我们并不需要保存 `parents` 和 `backward_op`。如果每次 decode 都偷偷构图，内存和时间都会被浪费。

Lumen 里还有一个很实用的开关：strict device execution。

```text
pub fn set_strict_device_execution(enabled: bool);
pub fn is_strict_device_execution() -> bool;
pub fn set_strict_device_execution_scoped(enabled: bool) -> StrictDeviceExecutionGuard;
```

它还可以通过环境变量 `LUMEN_STRICT_DEVICE` 打开。为什么需要它？因为 CPU/CUDA 混合库最容易出现一种“假快”或“假 CUDA”的情况：用户以为整个计算都在 GPU 上，实际上某个算子没有 CUDA 实现，悄悄 fallback 到 CPU。结果 benchmark 看起来还能跑，但数据已经在 host 和 device 之间来回搬运。

strict device execution 的意义是：让问题暴露出来，而不是藏起来。

在做库的时候，这类开关非常重要。它们像交通灯，不参与具体计算，却决定了系统在训练、推理、调试、benchmark 时到底该走哪条路。

* * *

### 12\. 从普通网络到 Llama：模型层开始有了性格

前面的部分可以支撑一个普通 MLP。但 Lumen 更有意思的地方，是它实现了 Llama 风格的 decoder。

Lumen 的 `LlamaConfig` 描述模型尺寸：

```text
pub struct LlamaConfig {
    pub vocab_size: usize,
    pub hidden_size: usize,
    pub intermediate_size: usize,
    pub num_hidden_layers: usize,
    pub num_attention_heads: usize,
    pub num_key_value_heads: usize,
    pub rms_norm_eps: f32,
    pub max_seq_len: usize,
    pub rope_theta: f32,
}
```

这一步很关键：模型结构不应该写死在代码里，而应该被配置描述。这样不同 vocab size、hidden size、head 配置、GQA 配置和 RoPE 参数都可以通过 config 控制。

LlamaModel 不只是 Linear 的堆叠。它包含：

```text
token embedding
RMSNorm
Self-Attention
RoPE
GQA
SwiGLU-style MLP
KV cache
output head
```

RMSNorm 的形式可以写成：

$$\\operatorname{RMSNorm}(x) = \\frac{x}{\\sqrt{\\frac{1}{d}\\sum\_{i=1}^{d}x\_i^2 + \\epsilon}} \\odot \\gamma$$

它不像 LayerNorm 那样减去均值，而是用均方根进行缩放。在 decoder-only 模型里，RMSNorm 是非常常见的选择。

Self-Attention 的核心是：

$$Q = XW\_Q, \\quad K = XW\_K, \\quad V = XW\_V$$

$$\\operatorname{Attention}(Q,K,V) = \\operatorname{softmax}\\left(\\frac{QK^T}{\\sqrt{d}} + M\\right)V$$

其中 $M$ 是 causal mask，用来阻止当前位置看到未来 token。

RoPE 则把位置信息注入到 $Q$ 和 $K$ 中。对二维向量片段，可以理解成一次旋转：

$$\\begin{bmatrix} x'\_1 \\\\ x'\_2 \\end{bmatrix} = \\begin{bmatrix} \\cos \\theta & -\\sin \\theta \\\\ \\sin \\theta & \\cos \\theta \\end{bmatrix} \\begin{bmatrix} x\_1 \\\\ x\_2 \\end{bmatrix}$$

它的美感在于：位置不再只是简单加到 embedding 上的绝对编号，而是进入了注意力计算的几何结构里。

MLP 部分则使用 SwiGLU 风格结构。Lumen 的 `llama.rs` 里也直接写出了它的含义：

```text
down(act(gate(x)) * up(x))
```

数学上可以写成：

$$\\operatorname{FFN}(x) = W\_{down}\\left(\\operatorname{SiLU}(W\_{gate}x) \\odot W\_{up}x\\right)$$

这些公式并不只是装饰。它们决定了库里需要哪些算子，哪些地方会成为热点，哪些地方适合 fusion。

比如 Attention 中的 Q、K、V projection 是推理热点；RoPE 会在 prefill 和 decode 中反复出现；KV cache 决定了长文本生成时的内存布局；GQA 会改变 head 的映射方式；SwiGLU 的 gate/up/down projection 又会引出 fused MLP 的优化空间。

这就是模型实现最有趣的地方：数学结构会慢慢长成工程结构。

* * *

### 13\. KV Cache：自回归推理的记忆

如果每生成一个 token，都重新计算整个 prompt 的 K 和 V，那么自回归推理会非常浪费。

假设当前序列长度是 $T$。没有 KV cache 时，第 $t$ 步需要重新计算前面所有 token 的 key/value。随着 $T$ 增长，重复计算会越来越多。

KV cache 的思想很简单：

```text
prefill 阶段：计算 prompt 的 K/V，存入 cache
decode 阶段：每次只计算新 token 的 K/V，append 到 cache
attention 阶段：Q 只来自新 token，K/V 来自历史 cache + 当前 token
```

数学上，decode 第 $t$ 步可以理解为：

$$q\_t = x\_t W\_Q$$

$$K\_{1:t} = \[K\_{1:t-1}; k\_t\], \\quad V\_{1:t} = \[V\_{1:t-1}; v\_t\]$$

$$o\_t = \\operatorname{softmax}\\left(\\frac{q\_t K\_{1:t}^T}{\\sqrt{d}}\\right)V\_{1:t}$$

这就是为什么推理路径和训练路径必须分开。训练时通常处理完整序列；推理 decode 时每一步只有一个新 token，但要读取越来越长的 cache。

Lumen 的 SelfAttention 里可以看到对 KV cache、RoPE append、decode S=1 热路径、GQA 映射的专门处理。这些代码不是为了好看，而是为了让每一步生成尽可能少做无用功。

一个语言模型 runtime 的体验，很多时候就取决于这些细节。不是“Attention 公式写对了”就够了，而是要让公式在 decode 场景里以正确的数据布局运行。

* * *

### 14\. 训练路径和推理路径：同一个模型，两种生命

一个常见误解是：只要 forward 写好了，训练和推理就都解决了。

实际不是。

训练时，我们通常需要完整序列、完整计算图、梯度保存和 backward：

```text
input sequence
    ↓
full forward with graph
    ↓
loss
    ↓
backward
    ↓
optimizer update
```

推理时，尤其是自回归生成，问题完全不同：

```text
prefill prompt
    ↓
建立 KV cache
    ↓
decode one token
    ↓
更新 KV cache
    ↓
重复 decode
```

训练关心吞吐，推理关心延迟；训练保存中间结果，推理尽量不要构图；训练可以接受更通用的 batch matmul，decode 则希望每一步都走最短热路径。

Lumen 的 Llama 实现里明确区分了 eval/no\_grad 路径和训练路径。SelfAttention 里也能看到这种分离：推理时支持 KV cache、decode S=1 的 online-softmax 热路径、GQA 不展开 repeat\_kv；训练时走可导的标准路径，例如 fused softmax 和 batch matmul。

这是一种很现实的工程选择。一个神经网络库如果把训练和推理强塞进同一条路径，代码表面上统一了，但性能和复杂度往往会反噬回来。

* * *

### 15\. Rust-first，不是 Rust-only：CPU 与 CUDA 的边界

Lumen 的 README 用一句话给项目定了很准确的位置：Rust-first, not Rust-only。

这句话值得展开。

Rust 适合写框架结构：Tensor、autograd、Module、precision policy、loader、tokenizer、CPU backend、CLI 和 benchmark。它给了系统清晰的所有权边界，也让很多状态管理更可控。

但 CUDA 性能生态主要仍在 CUDA C++、cuBLAS、cuDNN 和 NVIDIA 工具链里。强行把所有东西都写成纯 Rust，未必是务实选择。

所以 Lumen 的结构更像这样：

```text
Rust side
  ├─ Tensor / autograd graph
  ├─ layers / modules / losses / optimizers
  ├─ Llama runtime
  ├─ dtype and precision policy
  ├─ safetensors and tokenizer
  ├─ CPU kernels and backend dispatch
  └─ FFI wrappers

CUDA side
  ├─ device memory allocation and reuse
  ├─ cuBLAS-backed matrix operations
  ├─ optional cuDNN-backed primitives
  ├─ custom CUDA kernels
  ├─ KV-cache updates
  └─ selected forward/backward kernels
```

这不是语言信仰问题，而是边界设计问题。Rust 管结构，CUDA 管热路径。框架不需要假装底层硬件不存在，底层也不应该污染高层 API。

一个健康的神经网络库，应该让用户看到稳定的抽象，让开发者能替换底层路径。

Lumen 的 CUDA 支持通过 feature gate 控制：

```text
cargo build --release --features cuda
```

CPU-only 构建则不需要 CUDA：

```text
cargo build --release
```

这种设计让项目可以同时服务两类场景：没有 NVIDIA 环境时，仍然能编译和运行 CPU 路径；需要 GPU 加速时，再打开 CUDA feature，进入 FFI、nvcc、cuBLAS、cuDNN 和 custom kernel 的世界。

* * *

### 16\. Loader、Tokenizer 与 Runtime：模型不是凭空来的

当库走到 LlamaModel 这一步，另一个问题会出现：权重从哪里来？输入 token 从哪里来？推理循环谁来管？

Lumen 里有 `loader.rs`、`tokenizer.rs` 和 `main.rs`，这说明它已经不只是一个孤立的数学库，而是开始接近一个本地推理 runtime。

一个可用的 LLM runtime 至少要处理：

```text
checkpoint / safetensors
    ↓
weight mapping
    ↓
dtype conversion or quantization
    ↓
tokenizer encode
    ↓
prefill
    ↓
decode loop
    ↓
sampling / argmax
    ↓
tokenizer decode
```

这里的每一步都可能成为坑。

权重名字可能和模型结构不完全一致；safetensors 加载可能带来峰值内存问题；tokenizer 的特殊 token 会影响输出；量化加载要记录 scale；CUDA 权重要避免频繁 host-device 拷贝；KV cache 要提前分配还是动态增长，也会影响性能。

Lumen 支持 safetensors 加载，也支持 streamed loading。后者很重要，因为模型一大，加载阶段本身就可能成为内存峰值。它还支持 on-load quantization 和 offline quantized safetensors，这说明量化不只是一个 kernel 问题，也是一条完整的数据流：

```text
float checkpoint
    ↓
read tensor
    ↓
choose scale
    ↓
quantize to i8
    ↓
store i8 + scale
    ↓
runtime mixed compute
```

所以，“写一个神经网络库”和“写一个能跑模型的神经网络库”之间，隔着一条很长的工程河流。

* * *

### 17\. Benchmark：不要只相信感觉

神经网络库最容易产生错觉的地方，是性能。

一个 kernel 快，不代表整个模型快；decode 快，不代表 prefill 快；CUDA 快，不代表小 batch 也快；f16 快，不代表所有算子都适合 f16；OpenBLAS 快，也不代表在特定形状下比手写 Rayon 更快。

Lumen 中存在多个 benchmark 入口：

```text
src/bin/kernel_bench.rs
src/bin/prefill_decode_bench.rs
src/bin/cuda_cpu_bench.rs
```

这说明它把性能观察拆成了几层：

```text
micro benchmark       : 单个 kernel 是否快
operator benchmark    : matmul / softmax / cross_entropy 是否快
end-to-end benchmark  : prefill / decode 是否快
```

这三层都需要。只看第一层，会被局部优化欺骗；只看第三层，又很难知道瓶颈在哪里。

真正可靠的 benchmark 至少要交代：

```text
batch size
sequence length
hidden size
dtype
device
是否 warmup
是否同步 CUDA
是否包含 tokenizer
是否包含采样
是否允许 CPU fallback
```

尤其是 CPU/CUDA 混合路径，最怕“看起来跑在 CUDA 上，实际中间偷偷回了 CPU”。strict device execution 就是为了暴露这类问题：如果某个算子没有 CUDA 路径，就不要悄悄 fallback 掩盖问题。

性能优化最迷人的地方是，它经常违反直觉。你以为瓶颈在大矩阵乘，结果真正拖慢的是一次多余拷贝；你以为量化一定更快，结果 dequantization 和访存模式吃掉了收益；你以为 fused kernel 一定好，结果小 batch 下启动开销反而明显。

Benchmark 的意义，就是把这些直觉拉回地面。

* * *

### 18\. 测试：神经网络库需要防止“看起来能跑”

一个神经网络库最危险的状态不是“跑不起来”，而是“能跑，但悄悄错”。

梯度错一点，loss 也许还能下降；shape broadcast 错一点，训练也许还能给出结果；CUDA fallback 藏起来，benchmark 也许还能显示不错的数字。等问题暴露时，往往已经很难定位。

Lumen 源码里有不少 `#[test]`，覆盖 autograd、precision、attention、activation、optimizer、CUDA/CPU 对齐等场景。这样的测试不是形式主义，而是神经网络库的安全网。

一个比较健康的测试体系可以分成几类：

```text
数值正确性测试：forward 输出是否符合预期
梯度测试：backward 是否符合手推公式或数值差分
shape 测试：reshape / transpose / slice / broadcast 是否正确
精度测试：f32 / f16 / bf16 / i8 路径是否一致或误差可控
device 测试：CPU / CUDA 行为是否一致
模式测试：no_grad / inference mode 是否真的不构图
optimizer 测试：参数更新是否符合公式
runtime 测试：prefill / decode / KV cache 是否一致
```

其中梯度测试特别重要。对一个函数 $f(x)$，可以用数值差分检查梯度：

$$\\frac{\\partial f}{\\partial x} \\approx \\frac{f(x+\\epsilon)-f(x-\\epsilon)}{2\\epsilon}$$

自动求导的结果如果和数值差分差得太远，就说明某个 backward 规则出了问题。

当然，数值差分很慢，不适合所有大算子。但它适合用来验证小规模输入和关键算子。很多时候，一个 2×3 的小矩阵比一个真实模型更能暴露 bug。

* * *

### 19\. 如果从零开始写，可以按什么顺序来

如果真的要从零写一个神经网络库，不建议一上来就写 Llama，也不建议一上来就写 CUDA。更稳妥的路线是从最小闭环开始。

第一步，只做 Tensor 和基础数据结构：

```text
Tensor
shape
data
requires_grad
grad
```

第二步，实现几个基础算子和 autograd：

```text
add
mul
matmul
sum
mean
relu
reshape
transpose
```

第三步，实现 `backward()`，能训练一个线性回归：

```text
y = xW + b
loss = mean((y_pred - y)^2)
backward
SGD step
```

第四步，引入 Module：

```text
Linear
Sequential
parameters()
zero_grad()
```

第五步，实现更真实的训练组件：

```text
MSELoss
CrossEntropyLoss
Adam
Embedding
LayerNorm 或 RMSNorm
```

第六步，开始考虑 dtype 和 device：

```text
DType enum
CPU/CUDA device abstraction
no_grad
inference mode
```

第七步，再进入模型和 runtime：

```text
Transformer block
Attention
RoPE
KV cache
Tokenizer
Checkpoint loader
```

第八步，最后才是性能优化：

```text
matvec hot path
fused kernels
SIMD / Rayon
CUDA kernels
quantization
prefill/decode benchmark
```

这个顺序的好处是，每一层都能运行、能测试、能验证。不要等系统全部写完才发现最底层的梯度设计不支持 broadcast，也不要等 CUDA kernel 写完才发现 Tensor 的 device 语义不清楚。

Lumen 的价值就在于它把这些层次放在一个项目里。你可以从它身上看到最终形态，也可以倒推出一个合理的成长路线。

* * *

### 20\. 写神经网络库时，真正困难的地方

写神经网络库的困难，不在某一个公式。

矩阵乘的梯度可以推导，softmax 的梯度可以查到，Adam 的更新公式也不神秘。真正麻烦的是这些公式进入系统之后，彼此开始纠缠。

Tensor 要支持共享和可变；动态图要避免重复遍历；梯度要累加；参数 dtype 和梯度 dtype 不能混为一谈；CUDA Tensor 要避免不必要的 host sync；Module 要能收集参数；loader 要保证权重映射正确；inference 要绕开 autograd；benchmark 要避免假象。

Lumen 的实现能提供几个很有代表性的经验。

第一，Tensor 的设计要尽早考虑 autograd、dtype 和 device。后期再补，会让每个算子都被迫大改。

第二，动态图实现不需要一开始就复杂。`parents + backward_op + topo traversal` 已经能支撑一个清晰的核心。

第三，训练和推理最好从设计上分清。它们看起来都叫 forward，但工程目标不同。

第四，精度系统不要只做一个 enum。真正有用的是 policy：参数怎么存，激活怎么存，KV cache 怎么存，optimizer state 怎么存。

第五，CUDA 后端要有边界。高层保持统一 API，底层允许专门优化。

第六，benchmark 要伴随开发，而不是项目快结束时才补。

第七，测试要覆盖“小而关键”的场景。一个能跑 Llama 的库，如果不能保证小矩阵的梯度正确，迟早会在更大的地方迷路。

这些经验并不宏大，却很实在。一个神经网络库的生命力，往往就藏在这些小决定里。

* * *

### 21\. 再往源码里走一层：读 Lumen 可以按什么路径读

如果这篇文章是给读者解释“神经网络库由什么组成”，那么下一步就是告诉读者：真正打开 Lumen 源码时，应该从哪里开始读。

不建议一开始就读 `src/ops/matmul.rs` 或 `src/ops/cuda/lumen_cuda.cu`。这些文件很长，而且里面有大量性能分支；如果没有先理解 Tensor 和 dtype policy，很容易把注意力放在局部技巧上，却看不清整个系统为什么需要这些技巧。

更合适的阅读路线是：

```text
src/lib.rs
  ↓
src/autograd.rs
  ↓
src/module.rs
  ↓
src/layers/basic/linear.rs
  ↓
src/precision.rs
  ↓
src/models/llama.rs
  ↓
src/layers/attention/self_attention.rs
  ↓
src/loader.rs / src/main.rs
  ↓
src/ops/matmul.rs / src/ops/fused.rs / src/ops/cuda.rs
```

`lib.rs` 是总入口，可以先确认这个库暴露了哪些模块。`autograd.rs` 是核心，因为 Tensor、Device、StoragePreference、梯度、动态图、no\_grad、strict device 都在这里。`module.rs` 是模型组织方式，说明参数怎样被收集、保存、加载、转换 dtype 和迁移设备。`linear.rs` 则是第一块真正连接“层抽象”和“底层算子”的代码：它一边要像普通 Module，一边又要照顾 decode matvec 热路径。

读到 `precision.rs` 后，很多前面看起来奇怪的代码会变得合理：为什么 Tensor 同时有 f32、f16、bf16、i8 几种缓存？为什么有的路径希望 native storage，有的路径又希望 f32 compute view？为什么 `--allow-parameter-copies` 会影响性能和内存？这些问题都不是单个算子能解释的，而是整个精度策略共同决定的。

最后再进入 Llama 和 attention。这个顺序比较自然：先知道 Tensor 怎么活，再看 Module 怎么组织参数，再看 dtype 怎么选择路径，最后看 Transformer 如何使用这些能力。如果反过来一上来读 SelfAttention，很容易被 KV cache、RoPE、GQA、prefill、decode、CUDA fallback 混在一起的复杂性压住。

源码阅读还有一个技巧：先找“边界”，再看“实现”。例如：

```text
Tensor 和 ndarray 的边界在哪里？
Tensor 和 CUDA buffer 的边界在哪里？
Module 和 Optimizer 的边界在哪里？
训练 forward 和推理 forward 的边界在哪里？
权重加载和模型结构的边界在哪里？
```

神经网络库的复杂性，很多时候并不来自某个函数太难，而是来自边界太多。先找到边界，代码就会从一团实现细节变成一张地图。

* * *

### 22\. StoragePreference：同一个 Tensor，为什么要有不同“视图”

Lumen 的 Tensor 不只是“保存什么 dtype”，还要回答另一个问题：当前算子希望怎样读取这块数据？

在 `autograd.rs` 里可以看到一个非常有代表性的枚举：

```text
pub enum StoragePreference {
    Auto,
    Native,
    F32Compute,
}
```

它表达的是执行路径的偏好。

`Native` 意味着尽量使用 Tensor 当前的原生存储。例如权重是 i8，就直接拿 i8 数据和 scale；权重是 bf16，就尽量拿 bf16 buffer。这样可以减少内存占用，也能让某些 mixed kernel 直接工作。

`F32Compute` 则表示当前路径更适合拿 f32 计算视图。即使参数存成 bf16 或 i8，也可能先转成 f32 再算。这样更稳定，也可以复用通用 kernel，但代价是可能产生额外缓存和内存压力。

`Auto` 则把选择权交给 Tensor 内部和 dtype dispatch。它根据当前 tensor 的状态、dtype、是否允许 parameter copies、是否已有 f32 cache 等因素决定使用哪种视图。

这个设计非常适合作为文章里的一个重点，因为它说明 Lumen 的 dtype 系统不是“标签式”的。

很多最小实现会这样设计：

```text
struct Tensor {
    data: ArrayD<f32>,
    dtype: DType,
}
```

这其实很危险。因为 dtype 写成 `BF16`，并不代表所有算子都应该按 bf16 直接算；dtype 写成 `I8`，也不代表所有路径都能直接消费 i8。真正的 runtime 需要的是：

```text
这个 Tensor 逻辑上是什么 dtype？
它当前有哪些实际 storage？
这些 storage 哪些是新鲜的，哪些是缓存？
当前算子希望读取 native storage，还是 f32 compute view？
如果没有想要的 storage，是否允许临时 materialize？
```

这就是 `StoragePreference` 存在的意义。它把“Tensor 怎么存”和“算子怎么读”拆开了。

这类设计看似只是工程细节，但它会直接决定后续能不能优雅地支持量化、bf16、CUDA resident buffer，以及不同后端的调度策略。没有这层抽象，后面每个算子都要自己判断所有 dtype 组合，代码很快就会散掉。

* * *

### 23\. DTypeDispatch 与 KernelRouteClass：不是所有路径都该用同一个 kernel

Lumen 还把 dtype 组合进一步抽象成 dispatch 类型：

```text
pub enum DTypeDispatch {
    PureF32,
    SameF16,
    SameBF16,
    SameI8,
    Mixed,
}
```

这很直观：输入和权重都是 f32，就是 `PureF32`；都是 bf16，就是 `SameBF16`；一个是 f32、一个是 i8，就属于 `Mixed`。

但 Lumen 没有只停在 dtype 组合上。它还引入了 route class：

```text
pub enum KernelRouteClass {
    GenericMatmul,
    DecodeKernel,
    Argmax,
}
```

这一步很关键。因为“同样的 dtype 组合”，在不同场景下也可能应该走不同路径。

例如 `BF16 × BF16` 在普通 batch matmul 里，可能希望走某种通用计算路径；但在 decode kernel 里，如果当前 shape 已经退化成单 token matvec，就更关心读取权重的方式、内存连续性和输出延迟。

再比如 `Argmax` 路径。生成时有一个很现实的优化：如果只需要 greedy token，就不一定非要完整物化 `[B, 1, vocab]` 的 logits Tensor。可以直接对最后一个 hidden state 和 `lm_head.weight` 做 matvec，并在过程中找最大值。此时 dtype dispatch 不再只是“矩阵乘该怎么做”，而是“矩阵乘和 argmax 能不能合并成更短的路径”。

这就是为什么 Lumen 里不仅有 dtype，还有 route class。它把 kernel 选择从：

```text
根据 dtype 选 kernel
```

推进到了：

```text
根据 dtype + 场景 + shape + storage policy 选 kernel
```

这更接近真实推理 runtime 的样子。大模型推理里的热点通常不是一个孤立算子，而是一种固定场景：prefill、decode、lm\_head argmax、KV cache append、QKV projection、SwiGLU gate/up/down。把场景作为 dispatch 信息的一部分，能让优化更有方向。

* * *

### 24\. TensorRawData：保存模型时，保存的不只是 f32 数组

Lumen 的 Module 有自己的 `save` / `load`，它不是直接把所有参数都强制转成 f32，而是通过 `TensorRawData` 保存不同 dtype 的原始表示：

```text
pub enum TensorRawData {
    F32(Vec<f32>),
    F16(Vec<u16>),
    BF16(Vec<u16>),
    I8 { values: Vec<i8>, scale: f32 },
}
```

这个设计可以放到文章里单独讲。因为它说明 checkpoint 不只是“参数值”的集合，也是“存储策略”的集合。

如果保存 i8 权重，只保存 `Vec<i8>` 是不够的。必须同时保存 scale，否则反量化时不知道整数代表多大的实数范围。最简化的对称量化可以写成：

$$x \\approx s \\cdot q$$

其中 $q$ 是 i8，$s$ 是 scale。

因此 i8 checkpoint 的最小信息不是：

```text
values
```

而是：

```text
values + scale
```

这也是 safetensors 加载时为什么要找 companion scale tensor。一个离线量化后的权重文件，如果只包含 `.weight` 的 i8 数据，却没有 `.scale` 或 `_scale`，runtime 无法知道如何恢复近似值。

从库设计角度看，`TensorRawData` 很像一个“小型序列化协议”。它把 Tensor 内部复杂的多 storage 状态压成可以保存、传输、恢复的结构。这样 Module 的保存加载就不用理解 Linear、Embedding、RMSNorm 各自的内部数学，只需要遍历参数并导出 raw data。

这也再次体现了 Module 的意义：模型结构负责提供参数列表，Tensor 负责告诉外界如何序列化自己。边界清楚，功能才能组合。

* * *

### 25\. ParameterQuantization：量化不是一个 kernel，而是一条数据流

很多人一提量化，想到的是 int8 matmul。但在 Lumen 里，量化更像一条贯穿加载、存储、计算、保存的完整数据流。

它至少涉及四个环节：

```text
1. checkpoint 里原始权重是什么 dtype
2. 加载时是否要量化成 i8
3. Tensor 内部是否保留 f32 cache
4. 推理 kernel 是否直接消费 i8 native storage
```

Lumen 的 `ParameterQuantization` 把量化配置表达成两部分：目标整数 dtype 和 scale 策略。当前实现重点支持 i8，scale 可以自动推导，也可以手动指定。

概念上可以写成：

```text
pub struct ParameterQuantization {
    storage_dtype: Option<DType>,
    scale: QuantizationScale,
}

pub enum QuantizationScale {
    Auto,
    Manual(f32),
}
```

这比简单的 `bool quantized` 更有扩展性。因为量化至少要回答两个问题：

```text
量化到什么 dtype？
scale 从哪里来？
```

如果是 on-load quantization，那么 loader 会读取 f32/f16/bf16 权重，然后在导入 Tensor 时量化成 i8。如果是 offline quantization，则可以提前用 `quantize_safetensors` 生成 i8 checkpoint，运行时直接加载 i8 数据和 scale。

这两条路线的取舍不同：

```text
on-load quantization:
  优点：原始 checkpoint 不需要预处理，实验方便
  缺点：加载时更慢，第一次运行有额外开销

offline quantization:
  优点：运行时加载更直接，适合反复 benchmark
  缺点：需要额外生成文件，也要管理量化版本
```

更细一点说，量化路径还会受到 `allow_parameter_dtype_copies` 影响。如果允许参数 dtype copies，库可以保留更适合某些 kernel 的缓存版本；如果不允许，就更倾向直接从 i8 native storage 读取，节省内存，但对 kernel 实现要求更高。

这正是神经网络库里的典型取舍：省内存、少拷贝、低延迟、数值误差、实现复杂度，永远不可能同时最优。

* * *

### 26\. Loader：权重加载是模型 runtime 的第一道防线

Lumen 支持 safetensors 加载，也支持 streamed loading。这一部分看起来像外围功能，但它其实是模型 runtime 的第一道防线。

一个 loader 至少要检查这些事情：

```text
checkpoint 里有没有这个参数？
参数名能不能和模型结构对上？
shape 是否完全一致？
source dtype 是否支持？
target dtype 应该是什么？
是否要 on-load quantization？
i8 权重有没有 companion scale？
加载过程会不会制造过高的内存峰值？
```

Lumen 的 `ModelLoader` 做了一个很实用的事情：它会根据模型的 `named_parameters()` 去 checkpoint 里逐个找对应权重，而不是反过来盲目加载 checkpoint 里的所有 tensor。这种方式更适合“模型结构是主，权重文件是输入”的 runtime。

如果 checkpoint 少了某些参数，loader 会记录 missing 并打印摘要；如果 shape 对不上，就直接报错。这比静默跳过更好。神经网络权重加载最怕“看起来加载成功，其实某一层没对齐”。这种错误可能不会马上 panic，但输出会完全不可控。

streamed loading 的意义在于降低峰值内存。mmap 或一次性 deserialize 对小模型很方便，但模型变大时，加载阶段本身就可能吃掉大量内存。streamed loading 则更像：

```text
读取 safetensors header
  ↓
定位某个 tensor 的 byte range
  ↓
只读取当前参数所需的数据
  ↓
转换 dtype 或量化
  ↓
写入目标 Tensor
```

这也是从“玩具库”走向“runtime”的分水岭。玩具库通常假设参数已经在内存里；runtime 必须考虑权重文件很大、机器内存有限、加载后还要保留 KV cache 和 activation buffer。

在文章里补这一节，可以让读者看到：神经网络库不是只写数学运算。模型能否真正跑起来，很大一部分取决于 loader 是否可靠。

* * *

### 27\. CUDA build：后端不是一个 feature flag 就结束了

Lumen 的 CUDA 支持通过 Cargo feature 打开：

```text
cargo build --release --features cuda
```

但真正的 CUDA 后端远不止一个 feature flag。`build.rs` 要负责查找 CUDA toolkit、确认 `nvcc`、定位 cuDNN、编译 `.cu` 文件、链接 `cudart` / `cublas`，必要时还要处理 Windows 下的 DLL staging。

这部分特别适合写给读者，因为很多人以为“支持 CUDA”就是在 Rust 里调一个库。实际工程里，CUDA 后端至少包含：

```text
构建期：找到 CUDA、调用 nvcc、编译 native library
链接期：告诉 rustc 去哪里找 cudart/cublas/cudnn
运行期：确认动态库可见，确认设备可用
FFI 边界：把 Rust 侧 Tensor/CudaBuffer 映射到 CUDA C++ 函数
错误处理：CUDA kernel 失败时把错误带回 Rust 侧
fallback 策略：没有 CUDA kernel 时是否允许回退 CPU
```

Lumen 的 README 用 “Rust-first, not Rust-only” 描述这一点很准确。Rust 负责框架结构、状态管理、dtype policy 和高层 runtime；CUDA C++ 负责更接近硬件的部分。它不是承认 Rust 不行，而是承认生态和工具链现实。

这种边界设计也让 CPU-only 构建仍然可用：不开 `cuda` feature 时，项目仍然可以编译运行 CPU path；打开 feature 后，才进入 CUDA/cuBLAS/cuDNN/custom kernel 的世界。

这对一个学习型项目很重要。因为它降低了参与门槛：没有 NVIDIA 环境的人也能读和跑核心逻辑；需要研究 GPU 后端的人再进入更复杂的构建链。

* * *

### 28\. Runtime CLI：从模型 forward 到“能聊天”还差一段路

Lumen 的 `src/main.rs` 是一个很好的例子：模型 forward 只是 runtime 的核心，但不是 runtime 的全部。

一个最小聊天 CLI 至少还要处理：

```text
参数解析
模型配置
权重加载
tokenizer 加载
system / user / assistant prompt 格式
KV cache 初始化和 reset
prefill 和 decode 循环
采样策略
停止词
上下文长度溢出处理
输出流式打印
```

Lumen 的 CLI 支持 `--temperature`、`--top-p`、`--repetition-penalty`、`--recent-window`、`--max-gen`、`--device`、`--parameter-dtype`、`--activation-dtype`、`--kv-cache-dtype`、`--quantize`、`--stream-weights` 等参数。这些参数表明它已经不只是一个“能 forward 的模型”，而是在尝试把模型封装成可实验的本地推理程序。

其中采样部分很值得讲。temperature 接近 0 时，生成退化成 greedy argmax；temperature 大于 0 时，先缩放 logits，再做 softmax，然后按 top-p 截断候选集合，最后随机采样。

用流程表示就是：

```text
logits
  ↓
应用 repetition penalty
  ↓
除以 temperature
  ↓
softmax
  ↓
按概率从大到小排序
  ↓
保留累计概率达到 top_p 的候选
  ↓
随机采样一个 token
```

这说明 runtime 的体验并不完全由模型决定。prompt 模板、停止词、采样参数、重复惩罚、上下文 reset 策略都会影响输出。

还有一个细节是输出打印。Tokenizer decode 时可能出现 Unicode replacement character，或者一个 token 只构成半个字符。Lumen 的 CLI 通过比较上一次已经打印的字符串和当前完整 decode 字符串，只输出新增后缀。这类细节不属于神经网络数学，但属于“让模型像一个程序一样可用”的工程。

* * *

### 29\. 为什么 Lumen 适合做实验平台

Lumen 最有价值的地方，不一定是它已经覆盖了多少功能，而是它的结构适合做实验。

它不是 PyTorch 那种大而完整的生态，也不是只有几十行的教学 autograd。它处在一个很适合研究的中间地带：足够小，所以能读懂；足够完整，所以能跑出真实问题。

这让它适合做几类实验。

第一类是 dtype 实验。例如比较 f32、bf16、f16、i8 在不同路径上的影响：参数存储、activation、KV cache、optimizer state 是否分开配置，会直接影响速度、内存和数值行为。

第二类是位置编码实验。Lumen 已经有 Llama runtime 和 attention 结构，适合比较 absolute、relative bias、RoPE 等位置建模方式在训练 loss、验证 perplexity、长度外推和 decode 性能上的差别。因为它是自写 runtime，所以可以更直接观察某个编码方式对具体算子和缓存路径的影响。

第三类是 kernel 实验。`kernel_bench`、`prefill_decode_bench`、`cuda_cpu_bench` 这种工具可以把性能问题拆开：单 kernel 快不快，端到端 prefill/decode 快不快，CPU/CUDA 对齐是否正确。

第四类是量化实验。可以比较 on-load quantization 和 offline quantized safetensors；可以测试 i8 权重是否真的减少内存；也可以观察保留 f32 cache 是否提升速度但提高内存压力。

第五类是后端调度实验。例如在 CPU 上比较 Rayon、SIMD、不同 matvec 策略；在 CUDA 上比较 cuBLAS、custom kernel、融合 kernel 和 strict device 下的纯 GPU 路径。

这类实验如果放在成熟框架里，很多细节会被隐藏；如果放在玩具库里，又没有真实模型压力。Lumen 的优势就在这里：它让实验者既能控制底层，又能接近真实 LLM workload。

* * *

### 30\. 读者可能追问

**问题一：为什么不用 `Arc<Mutex<_>>`，而是 `Rc<RefCell<_>>`？**

Lumen 当前的并行主要放在算子内部：矩阵乘、matvec、softmax、RMSNorm、attention 这类计算热点，可以由 Rayon、SIMD、CUDA kernel 或 cuBLAS 承担并行执行。动态图节点本身则更像单机、单节点内的控制结构，负责保存父节点、反向函数、梯度和 dtype/device 状态。`Rc<RefCell<_>>` 用来表达这种局部计算图里的共享所有权和内部可变性，已经足够支撑当前的 forward/backward 控制逻辑。

在这个场景下，继续把高层动态图节点也做成高度并发共享对象，很容易成为过度并行。`Arc<Mutex<_>>` 解决的是“多个 host 线程共享并互斥修改同一个对象”的问题，但它并不会自动带来高效的动态图并行。相反，它可能让每次 TensorData 访问都带锁，让梯度累加发生锁竞争，也让反向传播中的父节点访问、闭包调用和设备同步更难设计。算子内并行已经覆盖主要计算热点时，把控制层也锁化，收益不一定能抵消复杂度。

即使未来支持多节点，`Arc<Mutex<_>>` 也不是天然更好的答案。多节点训练首先要决定并行策略：是每个节点各自持有完整权重，用数据并行处理不同 batch，再通过 all-reduce 同步梯度；还是让不同节点各自持有模型的一部分，走张量并行、流水并行、参数分片或 ZeRO 风格的状态切分？前者重点是梯度同步，后者重点是权重、激活和 optimizer state 的切分与通信调度。它们需要的是分布式执行器、通信后端、参数布局和同步协议，而不是简单把 `Rc<RefCell<_>>` 换成 `Arc<Mutex<_>>`。

所以这个问题的核心不是“以后要并行，所以现在应该用 `Arc<Mutex<_>>`”，而是“当前图控制层是否真的需要跨线程共享并发修改”。在 Lumen 目前的单机/单节点设计里，图控制结构保持轻量，计算密集部分交给算子内并行，是更合理的边界。

**问题二：为什么梯度仍然是 f32？**

因为参数存储和梯度累加关注的问题不同。参数 dtype 更关心内存、带宽和推理速度；梯度更关心数值稳定性。即使权重存成 bf16 或 i8，也不意味着梯度应该用同样 dtype。尤其是训练时，小梯度累加和 optimizer state 对精度更敏感。

**问题三：为什么训练路径和推理路径不完全复用？**

因为它们的目标不同。训练需要构图、保存中间结果、支持 backward；推理需要 no\_grad、KV cache、decode S=1 热路径、尽量少分配、尽量低延迟。强行复用会让代码表面统一，但性能和语义都会变复杂。

**问题四：strict device execution 有什么用？**

它是调试和 benchmark 的安全阀。没有它时，一个 CUDA Tensor 可能因为某个算子缺少 CUDA 实现而回退到 CPU。程序还能跑，但 benchmark 和设备语义都不可信。strict device 会把这种隐式 fallback 变成显式错误。

**问题五：为什么不一开始就全力优化 CUDA？**

因为后端优化建立在清晰的 Tensor、dtype、device、shape 和 autograd 边界上。如果边界没稳定，CUDA kernel 写得越多，后面改动成本越高。先把 CPU path、正确性测试和端到端 runtime 跑通，再逐步替换热点路径，通常更稳。

**问题六：Lumen 和 PyTorch 的关系是什么？**

Lumen 不适合被描述成“Rust 版 PyTorch”。它更像一个 Rust-first 的小型深度学习核心和 LLM inference playground。它的价值不是替代 PyTorch，而是把 Tensor、autograd、dtype、backend、loader、runtime 这些层次放在一个读者能看懂、能修改、能实验的项目里。

* * *

### 31\. 结语：库是模型和机器之间的翻译器

神经网络的数学表达通常很美观：

$$y = f(x;\\theta)$$

训练也可以写成一句话：

$$\\theta^\* = \\arg\\min\_\\theta L(f(x;\\theta), y)$$

但一旦你真的开始写库，就会发现这两行公式背后是一整套系统。Tensor 要保存数据和历史，算子要同时处理前向和反向，Module 要组织参数，Optimizer 要推动参数变化，precision policy 要在速度和稳定之间折中，backend 要把抽象落到真实硬件上。

Lumen 的价值，恰好在于它把这些层次放在一个足够小、足够具体的 Rust 项目里。你可以从 `autograd.rs` 看到 Tensor 如何长出计算图；从 `ops/` 看到数学符号如何落成 kernel；从 `module.rs` 看到模型组件如何组织参数；从 `precision.rs` 看到 dtype 如何成为一套策略；从 `models/llama.rs` 看到现代 decoder 如何穿过整个库栈。

写神经网络库像是在搭一座桥。一端是线性代数、概率和优化；另一端是内存布局、并行调度、硬件指令和工程边界。桥搭得越稳，模型就越自然地从公式走向机器。

而当某一天，你再次写下：

```text
loss.backward();
optimizer.step();
```

你看到的就不再只是两行 API，而是一条完整的河流：前向时流向结果，反向时带着梯度回到每一块参数，最后在 optimizer 的推动下，让模型悄悄变成更好的自己。

---

> 原文发表于知乎（2026-05-02）：<https://zhuanlan.zhihu.com/p/2034029680144163973>
