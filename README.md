# GeoServer Shapefile Publisher

使用 `batchPublish.js` 可以批量上传和发布 `shpfiles` 目录下的 Shapefile 至 GeoServer，并在发布时自动设置 UTF-8 编码以及根据原生范围计算边界。

## 前置条件
- 已安装 Node.js 18+（推荐 Node 20）。
- GeoServer REST 接口可访问。
- 操作系统中可用 `zip` 命令（用于临时压缩 Shapefile）。
- `shpfiles` 目录下每个图层包含至少 `.shp/.shx/.dbf` 文件，其余配套文件会一并上传。

## 快速开始
```bash
node batchPublish.js \
  --geoserver-url http://192.168.99.57:18080/geoserver \
  --workspace my_workspace \
  --username admin \
  --password bim%2018 \
  --directory ./test
```

你也可以通过环境变量提供连接信息：
```bash
export GEOSERVER_URL=http://192.168.99.57:18080/geoserver
export GEOSERVER_WORKSPACE=my_workspace
export GEOSERVER_USER=admin
export GEOSERVER_PASSWORD=bim%2018
node batchPublish.js
```

## 可选参数
- `--directory`/`--dir`：Shapefile 根目录，默认 `./shpfiles`。
- `--store-prefix`：创建数据存储时添加前缀。
- `--layer-prefix`：发布图层时添加前缀。
- `--overwrite`：若数据存储或图层已存在则覆盖并重新计算范围。

脚本会为每个 `.shp` 找出同名的支持文件，压缩后上传至 `/rest/workspaces/{workspace}/datastores/{store}/file.shp?charset=UTF-8`，随后调用 `featuretypes` 接口发布并执行 `recalculate=nativebbox,latlonbbox` 以从原生数据计算边界。

## 查询 wfs url 
```bash
node listWfsUrls.js --geoserver-url <url> --workspace <ws> --username <user> --password <pass> [--pretty]
```