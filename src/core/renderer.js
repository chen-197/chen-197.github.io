const path = require('path');
const ejs = require('ejs');

/**
 * 创建模板渲染器。globals 对所有模板可见（site / giscus / dev 等）。
 * render(name, data) 渲染 themes/<theme>/templates/<name>.ejs
 */
function createRenderer(themeDir, globals = {}) {
  const templatesDir = path.join(themeDir, 'templates');
  return function render(template, data = {}) {
    return ejs.renderFile(path.join(templatesDir, `${template}.ejs`), {
      encodeURIComponent,
      ...globals,
      ...data,
    });
  };
}

module.exports = { createRenderer };
