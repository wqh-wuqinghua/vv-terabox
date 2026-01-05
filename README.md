#记得rclone 的配置要通过base64的方式加入到secret里面！！
# 以下参数通过https://www.terabox.com 的get
### 第一步：登录TeraBox
1. 使用Chrome浏览器访问 https://www.terabox.com
2. 完成登录（重要：确保完全登录）

### 第二步：打开开发者工具
1. 按 `F12` 打开开发者工具
2. 切换到 `Network` 标签页
3. 在过滤框中输入 `getinfo`

### 第三步：触发API请求
1. 刷新页面（按 `Ctrl+R`）
2. 在Network标签页中会出现包含`getinfo`的请求


- TERABOX_JSTOKEN ✅
- TERABOX_COOKIE ✅
- TERABOX_BDSTOKEN 



 感谢这个解决：
 https://gist.github.com/nis267/74c6315f6dbd24a0b8889acdd08789e6 提供思路
    
