# 运维手册 —— dfzq-pi 五容器栈

这份文档写给运维。**不需要读任何代码**,照着敲就行。

所有命令都在这个 `ops/` 目录里执行:

```bash
cd <部署目录>/deploy/ops
```

四个脚本每一个都可以先加 `--dry-run` 空跑一遍 —— 只打印它将要执行的命令,
**不会**起停容器、不会拉镜像、不会碰数据。第一次用某个脚本时建议先这么看一眼。

---

## 一、症状 → 敲什么

| 症状 | 敲什么 |
|---|---|
| 新机器,从零开始装 | `./deploy.sh` |
| 页面报错 / 提问没反应 / 不知道哪儿坏了 | `./status.sh` → 照它最后「结论」那几行的提示做 |
| `status.sh` 说容器 running 但 healthz 不绿 | `./restart.sh` |
| 某个数据层容器挂了、没自动起来 | `./restart.sh --all` |
| 升到新版本 | `./deploy.sh --tag <新的 7 位 sha>` |
| 新版本有问题,要退回上一版 | `./deploy.sh --tag <旧的 7 位 sha>` |
| 计划内停机(搬机房、宿主机重启前) | `./stop.sh`,恢复时 `./deploy.sh` |
| 宿主机重启后 | 一般会自动起来;`./status.sh` 确认一下,不全绿就 `./deploy.sh` |
| 想知道现在跑的是哪个版本 | `./status.sh`,看「镜像」那一段 |

**拿不准就先 `./status.sh`。** 它只读、不改任何东西,随便跑多少次都行。

---

## 二、这套栈是什么

五个容器,一套 `compose.yml` 管起来:

| 容器 | 是什么 | 挂了会怎样 |
|---|---|---|
| `pg` | PostgreSQL 数据库。放全部**语料正文**、任务运行历史、字典表 | 提问全部失败;`pi` 的健康检查跟着变红 |
| `milvus` | 向量库。放语料的**向量索引**,检索靠它 | 提问全部失败或检索不到东西 |
| `etcd` | `milvus` 的元数据存储 | `milvus` 起不来 |
| `minio` | `milvus` 的对象存储 | `milvus` 起不来 |
| `pi` | 主服务。对外提供 `18080` 端口,页面/接口都打它 | 整个系统不可用 |

`etcd` 和 `minio` 只服务于 `milvus`,不对外开端口,平时不用管它们。

依赖关系:`etcd` + `minio` → `milvus`;`pg` + `milvus` → `pi`。
**修的时候从下往上修**:先让 `pg` / `milvus` 绿,`pi` 才可能绿。

对外只开三个端口,而且都绑在 `127.0.0.1`(只有本机能连):

| 端口 | 谁的 | 干什么用 |
|---|---|---|
| `18080` | `pi` | 主服务。端口号可以在 `.env` 的 `TASK_RUNTIME_PORT` 里改(只改宿主这一侧,容器内始终是 18080)。🔴 **禁止**把它暴露到办公网段 —— 这套系统没有任何鉴权,暴露即等于任人调用 |
| `5432` | `pg` | 本机排查用 |
| `19530` / `9091` | `milvus` | 本机排查用 |

---

## 三、`.env` 怎么填

配置文件是 `deploy/.env`(在 `ops/` 的**上一层**,和 `compose.yml` 放一起)。
样板是同目录的 `.env.example`,里面每一项都写了说明。

```bash
cd <部署目录>/deploy
cp .env.example .env
chmod 600 .env          # 权限必须是 600,里面有口令
vi .env                 # 填下面这些
```

**必须手工填、脚本填不了的**:

| 变量 | 填什么 |
|---|---|
| `PI_IMAGE` | 主服务镜像的完整地址,含版本 tag。开发会给你 |
| `PG_PASSWORD` | 数据库口令,自己定一个强口令 |
| `PIPELINE_DB_DSN` | 数据库连接串。里面的口令段要和 `PG_PASSWORD` 一致(且要 URL 编码)。主机名固定写 `pg`,端口固定写 `5432` |
| `LLM_API_KEY` | 大模型网关的 key |
| `LLM_BASE_URL` / `LLM_MODEL` | 大模型网关地址与模型名 |
| `LLM_CONTEXT_WINDOW` | 网关的上下文窗口大小,得看网关文档 |
| `PIPELINE_EMBEDDING_BASE_URL` / `PIPELINE_EMBEDDING_API_KEY` | 向量化网关地址与 key |
| `QUERY_RERANK_BASE_URL` / `QUERY_RERANK_API_KEY` | 重排网关地址与 key |
| `PIPELINE_SPARSE_BACKEND` | 现场结论,一般是 `bm25` |

`./deploy.sh` 第一步就会检查这些,少填哪个它会直接把变量名念出来。

三条书写纪律,踩了会出很难查的怪问题:

1. **行尾不要写注释**。`FOO=bar # 说明` 会让 `FOO` 的值变成 `bar # 说明`。注释另起一行,`#` 开头。
2. **不要用 `~`**,写完整路径。
3. **不要引用别的变量**(`FOO=$BAR` 不会展开,会被当成字面量)。

🔴 `PIPELINE_SPARSE_BACKEND` 要在**第一次** `./deploy.sh` 之前定好。
向量库的表结构是按这个值建的,建好就不再重建;事后再改,`./deploy.sh` 会直接报错停下
(它不会拿一个对不上的表凑合着跑)。真要改,找开发。

🔴 改了 `PG_PASSWORD` 就必须同步改 `PIPELINE_DB_DSN` 里的口令段。两边对不上时的表现是:
`pg` 是绿的,`pi` 不绿 —— 很容易误判成主服务的问题。

---

## 四、日志在哪

| 什么日志 | 在哪 |
|---|---|
| 四个脚本自己的日志 | `deploy/logs/<脚本名>-<时间戳>.log`,每跑一次一个新文件 |
| 某个容器的日志 | `docker logs --tail 100 <容器名>`;容器名用 `./status.sh` 看 |
| 主服务实时日志 | `docker logs -f <pi 的容器名>`,按 `Ctrl-C` 退出 |

脚本日志里的口令段会自动打码成 `***`,可以直接发给开发。
但 `docker logs` 的输出**没有**打码,发出去之前自己看一眼。

---

## 五、🔴 绝对不要敲的命令

下面这几条会**不可逆地删掉全部语料和向量索引**。删掉没有回收站、没有撤销、
docker 不会问你第二遍。重灌一轮现场实测是 **48.5 小时**。

| 不要敲 | 因为 |
|---|---|
| `docker-compose down -v` / `docker compose down -v` | `-v` = `--volumes` = 删卷。PG 语料 + Milvus 向量库**全没** |
| `docker volume rm ...` | 直接删掉点名的卷,一样是全没 |
| `docker volume prune` | 删掉所有"当前没有容器在用"的卷。🔴 用 `./stop.sh` 停机之后,**本栈的卷正好全部符合这个条件** |
| `docker system prune -a --volumes` | 上面那条的加强版,还会连镜像一起删 |
| `docker system prune -a` | 这条**不删卷**,但会删掉所有"没有容器在用"的镜像 —— 包括你想回退过去的那些旧版本。回退时就得重新拉,内网仓库不通的话当场卡住 |

想省磁盘的话,**只有这一条是安全的**:

```bash
docker builder prune          # 只清构建缓存,不碰数据
```

还不够就找开发,不要自己扩大删除范围。

停机不需要删任何东西 —— `./stop.sh` 就够了,它只停容器,卷原样留着。

---

## 六、故障排查:脚本报错时按锚点查

脚本报错的最后会带一句 `→ 见 ops/README.md 的「#xxx」一节`,在下面找同名小节。

### #no-docker —— 找不到 docker 命令

这台机器上没装 Docker,或者当前用户的 `PATH` 里没有它。

```bash
which docker
docker version
```

两条都没输出就是真没装 —— 这不该发生在已经交付的机器上,找开发。

### #no-compose-cmd —— 找不到 compose

脚本会自己认两种形态:新版的 `docker compose`(带空格)和老版的 `docker-compose`(带横杠)。
两种都找不到才报这条。

```bash
docker-compose version      # 生产机上应该是 1.29.2
docker compose version      # 新一点的机器上才有
```

都不行就是 compose 没装或不在 `PATH` 里,找开发。

### #docker-daemon-down —— Docker 守护进程没起来

```bash
systemctl status docker     # 看它活着没
systemctl start docker      # 起它
docker info                 # 再确认一次
```

`docker info` 还是报 `permission denied` 的话,是当前用户没权限访问 Docker,换 root 跑。

### #registry-unreachable —— 连不上镜像仓库 / 没登录

镜像放在公司内网的 JFrog 上,拉之前必须先登录一次(登录状态会记住,不用每次登)。

```bash
docker login jfrog.orientsec.com.cn
# 输入账号密码。成功会打印 Login Succeeded
```

登录时报证书错误(`x509`)的话,是这台机器不认内网的证书,需要改 Docker 配置或装内网 CA 证书 —— 这一步找开发,不要自己改。

登录成功了还是报这条,先确认网络通不通:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://jfrog.orientsec.com.cn/v2/
# 打印任何数字(包括 401)都算通;打印 000 就是网络不通
```

### #compose-file-missing —— 找不到 compose.yml

`compose.yml` 应该和 `.env` 一起放在 `ops/` 的上一层目录。

```bash
cd <部署目录>/deploy && echo *
# 应该看到 compose.yml、.env.example、ops/ 这些
```

看不到就是交付的文件不全或者位置搬错了,找开发要一份完整的 `deploy/` 目录。

### #env-missing —— 没有 .env

还没建配置文件。照第三节做一遍。

### #env-perm —— .env 权限不对

里面有数据库口令和网关 key,必须只有属主能读。

```bash
chmod 600 <部署目录>/deploy/.env
```

### #env-incomplete —— .env 有必填项是空的

报错里会把空着的变量名一个个列出来。打开 `.env` 把它们填上,
每一项该填什么在同目录的 `.env.example` 里都有说明,也可以看本文第三节的表。

### #pull-failed —— 拉镜像失败

按可能性从大到小:

1. 没登录仓库 → 看 `#registry-unreachable`
2. 版本 tag 打错了(`--tag` 后面跟的 sha 写错,或 `.env` 里的 `PI_IMAGE` 写错)→ 跟开发核对版本号
3. 网络不通 → 看 `#registry-unreachable` 里那条 `curl`

报错原文里通常会写 `manifest unknown`(= tag 不存在)或 `unauthorized`(= 没登录),
把那一行发给开发最快。

### #pg-not-healthy —— 数据库起不来

```bash
./status.sh                              # 先看整体
docker logs --tail 100 <pg 的容器名>      # 再看它自己的日志
```

常见两种:

- 日志里有 `Cannot allocate memory` 之类的字样 → 这台机器的 Docker 版本需要一个特殊开关才能跑这个数据库镜像,交付的 `compose.yml` 里已经配好了;如果报这个,说明 `compose.yml` 被改过或换了别的版本,找开发。
- 日志里有 `database files are incompatible` / `database directory is not empty` → 数据卷和镜像版本对不上。**不要删卷**,找开发。

磁盘满了也会让它起不来,顺手看一眼:`df -h /`。

### #etcd-not-healthy —— 向量库的元数据存储起不来

`etcd` 只服务于 `milvus`,自己不存业务数据。

```bash
docker logs --tail 100 <etcd 的容器名>
./restart.sh --all
```

重启一次多数就好了。反复起不来,并且日志里提到磁盘/空间,先看 `df -h /`。

### #minio-not-healthy —— 向量库的对象存储起不来

处理方式和上一节的 `etcd` 完全一样,它同样只服务于 `milvus`、自己不存业务数据。

```bash
docker logs --tail 100 <minio 的容器名>
./restart.sh --all
```

### #milvus-not-healthy —— 向量库起不来

`milvus` **首次启动要 90 秒以上**,脚本已经按这个等了,但如果机器很忙可能还是不够。

```bash
./status.sh                                  # HEALTH 是 starting 就再等等,是 unhealthy 才是真出事
docker logs --tail 100 <milvus 的容器名>
```

排查顺序:

1. `etcd` 和 `minio` 是不是先绿了?没绿先修它们(`milvus` 依赖这两个)。
2. 内存够不够?`milvus` 是这套栈里最吃内存的。`free -g` 看一眼。
3. 磁盘够不够?`df -h /`。

都正常还是不绿,`./restart.sh --all` 试一次;还不行找开发,把上面那份日志一起发过去。

### #container-down —— 某个容器不在运行

```bash
./restart.sh --all          # 数据层的容器
./restart.sh                # 只有 pi 的话
```

起不来就按上面对应的 `#xxx-not-healthy` 小节查。

### #init-failed —— 建库失败

第一次部署时建表 / 建向量库那一步挂了。报错信息里会写是哪一段。

最常见的一种:报错提到 `sparse_backend` 对不上 —— 说明向量库里已经有一个用**别的配置**建好的表,
和现在 `.env` 里 `PIPELINE_SPARSE_BACKEND` 的值不一致。脚本刻意**不**去凑合复用它(那会让检索结果悄悄变差)。
这种情况找开发,不要自己删卷重来。

其余情况把报错整段发给开发。

### #serve-not-healthy —— 容器活着,但服务是坏的

**这是最需要留意的一种故障。** 容器在 `docker ps` 里看着是 `Up`,但它其实已经不干活了。
Docker 不会自己修这种情况(它的自动重启只管"容器退出",健康检查失败不触发重启),
也没有任何看门狗会替你处理 —— **只有 `./status.sh` 能发现它**。

处理顺序:

```bash
./status.sh                                  # 1. 先确认 pg / milvus 是不是绿的
docker logs --tail 100 <pi 的容器名>          # 2. 看主服务日志的最后几行
./restart.sh                                 # 3. 重启主服务
```

按日志内容分两类:

- 日志里提到连不上数据库或向量库(`connection refused`、`timeout`、`ECONNREFUSED`)
  → 是下层的问题,`./restart.sh --all`,等数据层全绿了再看主服务。
- 日志里提到缺环境变量、key 不对、鉴权失败(`missing`、`unauthorized`、`401`)
  → 是 `.env` 的问题。按第三节核对,改完跑 `./deploy.sh`。

重启两次还不绿,把 `./status.sh` 的完整输出 + `docker logs --tail 200 <pi 的容器名>` 发给开发。
**不要**为了"清干净重来"去删卷,那和这个故障没有任何关系。

---

## 七、几件平时容易问的事

**Q:重跑 `./deploy.sh` 会不会把数据洗掉?**
不会。它每一步都是先看真实状态再决定做不做:容器已经健康就不重建,表已经建好就跳过。
连着跑十遍也是一样的结果。升级和回滚用的就是它。

**Q:回滚具体怎么做?**
`./deploy.sh --tag <旧版本的 7 位 sha>`。它只换主服务的镜像版本,数据不动。
旧版本号找开发要,或者在换版本之前先 `./status.sh` 把当前版本记下来。

**Q:`./status.sh` 退出码是 1,是不是它自己出错了?**
不是。它发现异常就返回 1,一切正常返回 0,方便挂到定时任务里当探针。
它自己出错会明确打印 `ERR`。

**Q:宿主机重启之后要做什么?**
容器配了自动拉起,一般会自己回来。跑一次 `./status.sh` 确认;不全绿就 `./deploy.sh`。

**Q:磁盘快满了怎么办?**
`docker builder prune` 清构建缓存,这条是安全的。再不够找开发,
**不要**用第五节里那几条带删除性质的命令。
