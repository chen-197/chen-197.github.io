---
title: 编写.service文件
date: 2022-07-25
tags: [Linux, systemd]
categories: 技术
---

注：本文适用于systemd用户，其他init可能有些出入比如你用的是openRC或SysVinit等，具体参见其官方文档。

什么是.service文件？

Linux中.service文件是某项服务对应的配置文件，可用于systemd管理和控制的服务的设置。

.service 文件通常包含3个模块，即\[Unit\]控制单元，表示启动顺序和依赖关系；\[Service\]服务，表示服务的定义；\[Install\]安装，表示如何安装配置文件。

也许大家经常要用到这些指令：systemctl enable xxx，systemctl start xxx，等等。xxx便可以是.service文件。

enable xxx.service意为开机自启该项服务，disable xxx.service意为取消开机自启该项服务，stop意为停止该项服务，start意为启动该项服务。也可以不加sudo，而是加一个`--user`，组成：`systemctl --user start xxx`，即操作当前用户的 systemd 实例，管理用户级服务。

现在我们要写一个.service，命名为pulseaudiostart.service，它将执行pulseaudio --start指令：

```ini
# 注意：unit 文件的注释必须单独成行，写在行尾会被当作配置值的一部分
[Unit]
Description=Start pulseaudio

[Service]
# pulseaudio --start 会自我守护化（fork 后启动器进程退出），所以启动类型用 forking
Type=forking
ExecStart=/usr/bin/pulseaudio --start
ExecStop=/usr/bin/pulseaudio --kill

[Install]
# 用户级服务挂在 default.target；系统级服务才用 multi-user.target
WantedBy=default.target
```

然后放在什么地方呢？下面这张图片也许可以作为参考：

![serviceaddress](/images/systemd-directories.jpeg)

系统服务可以放在：/usr/lib/systemd/system/ ， 用户服务可以放在：/usr/lib/systemd/user/ （具体看上图）  
但不建议管理员直接往上面提到的这两个地方放。给管理员用的可以是/etc/systemd/system和/etc/systemd/user  
一般来说，对于那些支持systemd的软件，安装的时候，会自动在/usr/lib/systemd/system目录添加一个配置文件，但是也有例外，比如我的gentoo默认是在/lib/systemd/system/  
如图：  
![example1](/images/systemd-example-1.jpeg)  
![example2](/images/systemd-example-2.png)  
![example3](/images/systemd-example-3.jpeg)  
当然也可以放在~/.config/systemd/user/

本文的示例是用户级服务，就把它放到 `~/.config/systemd/user/pulseaudiostart.service`。

新建或修改 unit 文件后，需要先让 systemd 重新加载配置，然后才能启动：

```bash
systemctl --user daemon-reload
systemctl --user start pulseaudiostart.service
# 想让它随用户登录自动启动：
systemctl --user enable pulseaudiostart.service
```

---

现在，我们对.service文件做更多的解释：  
对于\[Service\]中的Type字段，它定义的是启动类型，它可以设置的值如下：  
simple：ExecStart字段启动的进程为主进程。指定了ExecStart但没写Type时默认就是它（没写ExecStart时隐含为oneshot，写了BusName时默认为dbus）。官方手册还提示：多数情况下显式写Type=exec更好  
exec：与simple类似，但systemd会等进程真正execve成功后才认为启动完成  
forking：ExecStart字段将以fork()方式启动，此时父进程将会退出，子进程将成为主进程。官方建议此类型配合PIDFile=使用，便于systemd可靠地识别主进程  
oneshot：类似于simple，但只执行一次，Systemd 会等它执行完，才启动其他服务  
dbus：类似于simple，但会等待服务取得BusName=指定的 D-Bus 名称后，才算启动完成  
notify：类似于simple，启动结束后会发出通知信号，然后 Systemd 再启动其他服务  
notify-reload：类似于notify，且被要求重新加载时服务收到SIGHUP，并通过sd_notify回复RELOADING=1/READY=1告知加载完成  
idle：类似于simple，但是要等到其他任务都执行完，才会启动该服务。一种使用场合是为让该服务的输出，不与其他服务的输出相混合

---

\[Unit\] 区块中可以设置After字段和Before字段，After字段表示应该在哪些服务之后启动，Before字段表示应该在哪些服务之前启动。  
比如After=network.target sshd-keygen.service表示如果network.target或sshd-keygen.service需要启动，那么指定的服务应该在它们启动之后启动。  
设置依赖关系，需要使用Wants字段和Requires字段。  
Wants字段：表示该服务与Wants指定服务之间存在"弱依赖"关系，即如果Wants指定服务启动失败或停止运行，不影响该服务继续执行。  
Requires字段则表示"强依赖"关系：本服务启动时会一并启动其指定的服务；若指定服务启动失败且设置了After=，本服务不会启动；指定服务被显式停止时，本服务也会被停止。  
注意：依赖关系不决定启动顺序——Requires=和Wants=都不保证先后，需要顺序就要同时写After=。官方手册还建议，多数场景用Wants=比Requires=更稳健。

---

\[Service\] 区块中，除ExecStart字段和ExecStop字段外，还有：  
ExecReload字段：重新加载配置（systemctl reload）时执行的命令  
ExecStartPre字段：启动服务之前执行的命令  
ExecStartPost字段：启动服务之后执行的命令  
ExecStopPost字段：停止服务之后执行的命令

KillMode字段：定义 Systemd 如何停止服务。  
KillMode字段可以设置的值如下：  
control-group（默认值）：当前控制组里面的所有子进程，都会被杀掉  
process：只杀主进程  
mixed：主进程将收到 SIGTERM 信号，子进程收到 SIGKILL 信号  
none：没有进程会被杀掉，只是执行服务的 stop 命令。（官方对这两个值都给出了警告：process 不推荐，none 强烈不推荐，因为会留下未被清理的存活进程。）

Restart字段：定义了进程退出后，Systemd 的重启方式。  
no（默认值）：退出后不会重启  
on-success：只有正常退出时（退出状态码为0），才会重启  
on-failure：非正常退出时（退出状态码非0），包括被信号终止和超时，才会重启  
on-abnormal：只有被信号终止和超时，才会重启  
on-abort：只有在收到没有捕捉到的信号终止时，才会重启  
on-watchdog：超时退出，才会重启  
always：不管是什么退出原因，总是重启

RestartSec字段：表示 Systemd 重启进程之前，需要等待的秒数。  
RemainAfterExit字段：设置RemainAfterExit=yes使得 systemd 在服务进程退出之后仍然认为服务处于激活状态。

---

\[Install\] 区块定义如何安装这个配置文件

WantedBy字段：表示该服务所在的 Target。  
Target的含义是服务组，表示一组服务。  
WantedBy=multi-user.target指的是，该服务所在的 Target 是multi-user.target。systemd 默认的启动 Target 是default.target（服务器上它通常链接到multi-user.target，桌面环境则是graphical.target），被它"需要"的服务都会随开机启动。systemctl enable 的本质，就是按 \[Install\] 区块的 WantedBy 创建指向该 unit 的软链接（如 /etc/systemd/system/multi-user.target.wants/ 下）；\[Install\] 区块也只在 enable 时才起作用。

关于Target,详情参见：  
https://www.freedesktop.org/software/systemd/man/bootup.html#System%20Manager%20Bootup

---

参考文章：http://www.ruanyifeng.com/blog/2016/03/systemd-tutorial-part-two.html

https://wiki.archlinux.org/title/Systemd

还有诸多参与讨论的群友们，在此一并表示感谢。

---

> 本文写于 2022-07-25（高考后的暑假），2024-10-04 整理发表于 CSDN：<https://blog.csdn.net/qq_31588401/article/details/142704132>
>
> 2026-09 修订：修正示例 unit（注释须单独成行、Type 由 simple 改为 forking、WantedBy 与 `--user` 用法统一为 default.target）、补充 daemon-reload 与 enable 步骤、订正 ExecReload 和默认 Target 的描述；二次核查时补上 Type= 枚举遗漏的 exec 与 notify-reload、按官方手册修正默认值规则与 Requires= 语义（含 After= 前提）、补注"依赖不决定顺序"、forking 建议配合 PIDFile=、标注 KillMode 官方警告。全部修订均对照 systemd 官方手册逐条核实（systemd.syntax(7)、systemd.unit(5)、systemd.service(5)、systemd.kill(5)、systemd.special(7)）。
