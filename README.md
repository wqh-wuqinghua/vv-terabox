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



## 去掉自动
 auto-restart:
    needs: record
    runs-on: ubuntu-latest
    if: ${{ always() }}
    steps:
      # ⚠️ 你原来这里引用了 steps.gate.outputs.run，但没有名为 gate 的步骤，会永远跳过
      # 如果你就是想总是自触发一次（不建议），去掉 if 条件；否则请真正加上 gate 步骤。
      - name: Trigger self
        uses: benc-uk/workflow-dispatch@v1
        with:
          workflow: record.yml
          ref: ${{ github.ref }}
          token: ${{ secrets.GITHUB_TOKEN }}




## 感谢这个解决：
 https://gist.github.com/nis267/74c6315f6dbd24a0b8889acdd08789e6 提供思路
    
