---
title: UEFI-GPT安装Archlinux简易教程
date: 2022-07-24
tags: [Linux, Arch Linux]
categories: 技术
---

> **2026 年说明**：本文写于 2022 年 7 月，并于 2026-09 按[官方安装指南](https://wiki.archlinux.org/title/Installation_guide)与 Arch Wiki 把正文更新成了现行做法——所有改动处都带「**2026 更新**」标注，照着正文做即可；每处改了什么见文末修订记录。整体流程（分区、pacstrap、chroot、GRUB）四年没有变化。新手也可以考虑官方的引导式安装器 [archinstall](https://wiki.archlinux.org/title/Archinstall)。

#### 1.下载镜像，制作安装U盘，使用U盘启动（具体步骤略）

贴上下载页面地址  
https://archlinux.org/download/

#### 2.启动后，首先连接网络

使用WiFi连接互联网:

```bash
rfkill unblock wifi
iwctl device list
# 将DEVICE换成你的网络设备
iwctl station DEVICE scan
iwctl station DEVICE get-networks
# 如果有密码(将PASSWORD换成密码，将DEVICE换成你的网络设备，将NETWORK换成你要用的网络)
iwctl --passphrase PASSWORD station DEVICE connect NETWORK
# 如果没有密码
iwctl station DEVICE connect NETWORK
```

或直接使用网线连接互联网

对连接情况进行测试

```bash
ping www.baidu.com
```

#### 3.同步网络时间

```bash
timedatectl set-ntp true
```

#### 4.修改发行源

```bash
vim /etc/pacman.d/mirrorlist
```

不想用vim的话，用nano也可以  
推荐把163源放到最前面，其他的国内源也可以，建议多写几行，然后把国外源全删掉  
具体换源方法参照各大开源镜像站的介绍

> **2026 更新**：也可以用 `reflector` 按国家、最新、速度等条件自动生成镜像列表。

#### 5.磁盘分区

使用以下命令查看磁盘

```bash
lsblk
```

或者

```bash
fdisk -l
```

使用以下命令进行系统分区

```bash
fdisk /dev/XXX  #XXX换成你要指定的磁盘
```

不想用fdisk的话，用cfdisk也可以。修改完记得写入保存。  
将要分3个区：ESP，根，交换。如果你想使用交换文件，交换分区可以不要。你也可以分一个home区，看你是否需要了。  
一般来说，ESP几百MB完全足够，根分区推荐给大一点（一般来说一百多G够日常使用，有别的需求可以更多），swap分区的大小建议与你的运行内存大小一致。  
如果你没有ESP，那就需要新建。注意！如果你已经有ESP，那么里面很可能有其他系统的引导文件，下面的格式化（mkfs）步骤一定要慎重！  
为了方便描述，现在规定：  
ESP是/dev/sda1  
根是/dev/sda2  
swap是/dev/sda3  
在接下来的安装过程中，请结合自己实际情况修改  
格式化ESP：

```bash
mkfs.vfat -F 32 /dev/sda1      # 【2026 更新】ESP 要求 FAT32，官方指南明确写 -F 32（原文漏了）
```

格式化根分区：

```bash
mkfs.ext4 /dev/sda2      #也可以是其他的文件系统
```

设置交换分区：

```bash
mkswap /dev/sda3
```

启用交换分区：

```bash
swapon /dev/sda3
```

#### 6.挂载分区

```bash
mount /dev/sda2 /mnt
mkdir -p /mnt/boot/EFI
mount /dev/sda1 /mnt/boot/EFI
```

使用

```bash
lsblk
```

可以检查分区挂载是否正确

> **2026 提示**：官方指南现在的惯例是把 ESP 挂到小写的 `/mnt/boot` 或 `/mnt/efi`。本文的 `/boot/EFI` 一样能用，只要后面 GRUB 的 `--efi-directory` 参数与之对应即可。

#### 7.安装系统软件包

> **2026 更新**：官方指南现行写法是 `pacstrap -K /mnt base linux linux-firmware`。`base-devel`（编译 AUR 包时才需要）、`linux-headers`（编译内核外模块时才需要）、`dhcpcd`（本文用 NetworkManager，见第 15 步）都可以不装。注意 **sudo 要显式安装**——原文是靠 base-devel 顺带装上 sudo 的，去掉它之后必须单独装，否则第 14 步配不了 sudo。NetworkManager 也直接在这里装上。

```bash
pacstrap -K /mnt base linux linux-firmware sudo networkmanager
```

推荐一并安装：CPU 微码（Intel 装 `intel-ucode`，AMD 装 `amd-ucode`，二选一；GRUB 生成配置时会自动识别），ntfs-3g

#### 8.配置fstab

自动配置：

```bash
genfstab -U /mnt >> /mnt/etc/fstab      #也可以是genfstab -L /mnt >> /mnt/etc/fstab
```

-U指以UUID标识分区，而-L是以Label标识，假如你的Linux装在移动硬盘，这里推荐-U，因为-L很可能因为新机器上识别的Label不一致而无法启动
手动配置请自行查阅archwiki。  
使用

```bash
cat /mnt/etc/fstab
```

检查 fstab 是否正确

#### 9.切换至新系统

```bash
arch-chroot /mnt
```

#### 10.修改 locale 设定

```bash
pacman -S nano vim
vim /etc/locale.gen      #也可以用nano
```

找到下面这两行

```bash
#en_US.UTF-8 UTF-8
#zh_CN.UTF-8 UTF-8
```

反注释即可  
接下来

```bash
locale-gen
echo LANG=en_US.UTF-8 > /etc/locale.conf
```

#### 11.时间与主机名设置

设置时区

```bash
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
```

假如你在别的时区，也可以设成你所在的时区  
同步硬件时间

```bash
hwclock --systohc --utc
```

设置主机名

> **2026 更新**：这一步原文漏了，官方安装指南包含此步骤。

```bash
echo 你的主机名 > /etc/hostname
```

#### 12.安装启动引导

```bash
pacman -S dosfstools grub efibootmgr os-prober
grub-install --target=x86_64-efi --efi-directory=/boot/EFI --recheck
grub-mkconfig -o /boot/grub/grub.cfg
```

如果要引导其他系统（比如 Windows 双系统），还需要允许 grub 去扫描它们：GRUB 2.06 起默认关闭了 os-prober，要在 `/etc/default/grub` 里加上 `GRUB_DISABLE_OS_PROBER=false`，然后重新执行一次 `grub-mkconfig -o /boot/grub/grub.cfg`，否则菜单里不会出现 Windows。

#### 13.修改 root 密码

```bash
passwd
```

#### 14.创建新用户

```bash
useradd -m -G wheel -s /bin/bash YOURS_USERNAME      #将YOURS_USERNAME替换成你的用户名
```

修改密码

```bash
passwd YOURS_USERNAME      #将YOURS_USERNAME替换成你的用户名
```

给新用户 sudo 权限

```bash
visudo
```

（官方建议始终用 `visudo` 编辑 sudoers，它保存时会做语法检查——直接用 vim 改假如写错语法，sudo 就彻底不能用了，会把人锁在门外）

> **2026 更新**：现在的惯例是启用 wheel 组的现成规则，而不是给单个用户单独写一条。找到下面这一行，去掉行首的 `#` 即可：

```bash
# %wheel ALL=(ALL) ALL
```

#### 15.网络：WiFi（如果你需要）

> **2026 更新**：NetworkManager 已在第 7 步装好，WiFi 所需的 `wpa_supplicant` 是它的依赖、会自动带上，这一步不用再装包。进桌面后连 WiFi 用 `nmtui`（文字界面）或桌面环境自带的网络小程序。

注意：**不要启用 dhcpcd**。本文用的是 NetworkManager，两个 DHCP 客户端同时启用会互相抢网卡，导致网络时通时断。只有当你决定不用 NetworkManager 时，才需要 `systemctl enable dhcpcd`。

#### 16.安装显卡驱动

Intel 或 AMD 显卡

> **2026 更新**：不再需要安装 `xf86-video-intel` / `xf86-video-ati` 这类 DDX 驱动（内核自带 i915/amdgpu 驱动，Xorg 用内置的 modesetting 即可），只需装用户态的 `mesa` 提供 OpenGL/Vulkan。Intel 官方 Wiki 现在也明确写着 xf86-video-intel "generally not recommended"。

```bash
pacman -S mesa
```

NVIDIA 显卡

> **2026 更新**：内核自带的开源 nouveau 对新卡支持有限，一般安装闭源驱动（原文写的是装 xf86-video-nouveau）。

```bash
pacman -S nvidia nvidia-utils
```

另外，接下来要安装的xorg全家桶里包含了通用驱动。

#### 17.安装xorg

```bash
pacman -S xorg
```

> **2026 更新**：XFCE 仍基于 X11，需要这一步；KDE 和 GNOME 现在默认 Wayland 会话，可以不装完整 xorg 组。另外 xorg-server 会自动带上触摸板所需的 `xf86-input-libinput`（见第 21 步）。

#### 18.安装一些中文字体

> **2026 更新**：现在更常用 Noto 系列，覆盖面广，中日韩统一。

```bash
pacman -S noto-fonts noto-fonts-cjk
```

#### 19.安装桌面环境

假如你要用xfce

```bash
pacman -S xfce4 xfce4-goodies lightdm
```

然后

```bash
systemctl enable lightdm
```

假如你要用KDE

> **2026 更新**：KDE Wiki 现行的写法是装 `plasma-meta` 元包（或 `plasma` 包组），应用套装用 `kde-applications-meta`（或 `kde-applications` 包组）；sddm 仍需单独安装。

```bash
pacman -S plasma-meta kde-applications-meta sddm
```

然后

```bash
systemctl enable sddm
```

假如你要用Gnome

```bash
pacman -S gnome gnome-extra
```

然后

```bash
systemctl enable gdm
```

假如你要用DDE

> **2026 提示**：Arch Wiki 目前在 DDE 页面挂着 openSUSE 安全团队对其"缺乏安全文化"的评估警告，选择前请自行斟酌。

```bash
pacman -S deepin deepin-extra lightdm
```

然后

```bash
systemctl enable lightdm
```

假如你要用其他的DE或者WM，请自行查阅archwiki。

#### 20.启用 NetworkManager

> **2026 更新**：NetworkManager 已在第 7 步随系统安装，这里只需要启用。

```bash
systemctl enable NetworkManager
```

#### 21.触控板驱动（假如需要）

> **2026 更新**：现在默认使用 `xf86-input-libinput`，装 xorg 时已作为依赖自动带上，无需单独安装；`xf86-input-synaptics` 已是遗留选项，仅特殊需求才用。

#### 22.安装蓝牙驱动（假如需要）

```bash
pacman -S bluez bluez-utils
systemctl enable bluetooth.service
```

#### 23.退出chroot

```bash
exit
```

#### 24.重启

```bash
umount -R /mnt    # 2026 补充：官方指南建议，重启前先确认分区干净卸载
reboot
```

#### 25.enjoy！

---

> 本文写于 2022-07-24（高考后的暑假），2024-10-04 整理发表于 CSDN：<https://blog.csdn.net/qq_31588401/article/details/142704172>
>
> 2026-09 修订：先修正原文错误（KDE 分支补 `sddm`、DDE 分支补 `lightdm`、去掉无用的 `dialog`、解决 `dhcpcd` 与 NetworkManager 同时启用的冲突、补充双系统 os-prober 说明）；随后把正文全面更新为 2026 年现行做法——`pacstrap` 精简为 `base linux linux-firmware sudo networkmanager`、显卡改为 mesa / 闭源 nvidia、字体改 Noto 系列、触控板用 libinput、用户加入 wheel 组、补上主机名步骤、重启前卸载分区等，正文中所有更新处均带「2026 更新」标注。全部修订均对照 Arch 官方安装指南、Arch Wiki 与 archlinux.org 包数据库逐条核实。
