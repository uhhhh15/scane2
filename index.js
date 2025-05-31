// public/extensions/third-party/scane/index.js

import {
    extension_settings,
    getContext, // 如果需要使用 context 对象，则导入
    renderExtensionTemplateAsync,
    // loadExtensionSettings // 这个函数通常由 ST 核心调用，插件一般不需要主动导入和调用
} from '../../../extensions.js';

// 从 script.js 导入
import {
    saveSettingsDebounced,
    eventSource,
    event_types, // 如果需要监听事件，则导入
    // 其他可能需要的函数，如 messageFormatting, addOneMessage 等
} from '../../../../script.js';

// 如果你的插件需要弹窗功能，从 popup.js 导入
import {
    Popup,
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

// 如果需要 UUID 或时间戳处理等工具函数，从 utils.js 导入
import {
    uuidv4,
    timestampToMoment,
} from '../../../utils.js';

// 插件的命名空间，与 manifest.json 中的文件夹名称一致
const PLUGIN_ID = 'scane2';
const PLUGIN_NAME = 'ST截图3.0'; // 更新插件名以区分

// 插件的默认设置
const defaultSettings = {
    screenshotDelay: 10,       // 可以设置更低值，比如 0-20
    autoInstallButtons: true,
    altButtonLocation: true,
    screenshotScale: 2.0,      // 提高到 2.0 以提供清晰度
    useForeignObjectRendering: true, // dom-to-image-more 也支持
    imageTimeout: 4000,        // dom-to-image-more 支持 imageTimeout
    debugOverlay: true,        // 新增：是否显示进度遮罩层
    cacheBust: true,           // 新增：用于 dom-to-image-more 强制重新加载图片
    corsImg: {
        url: 'https://corsproxy.io/?#{cors}', // 使用公共CORS代理
        method: 'GET',
        headers: {
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
        }
    },
};

// 全局配置对象，将从设置中加载
const config = {
    buttonClass: 'st-screenshot-button',
    chatScrollContainerSelector: '#chat',
    chatContentSelector: '#chat',
    messageSelector: '.mes',
    lastMessageSelector: '.mes.last_mes',
    messageTextSelector: '.mes_block .mes_text',
    messageHeaderSelector: '.mes_block .ch_name',
    domToImageOptions: { // 重命名
        bgcolor: null, // 确保背景透明
        // 其他选项会从 settings 加载，不要在这里硬编码
        // dom-to-image-more 的一些默认行为可能覆盖 html2canvas 的某些选项
    }
};

// 确保插件设置已加载并与默认值合并
function getPluginSettings() {
    extension_settings[PLUGIN_ID] = extension_settings[PLUGIN_ID] || {};
    Object.assign(extension_settings[PLUGIN_ID], { ...defaultSettings, ...extension_settings[PLUGIN_ID] });
    return extension_settings[PLUGIN_ID];
}

// 加载并应用配置
function loadConfig() {
    const settings = getPluginSettings();

    // 基本配置
    config.screenshotDelay = parseInt(settings.screenshotDelay, 10) || 0;

    // 将所有 dom-to-image 相关设置正确地应用到 domToImageOptions
    const loadedScale = parseFloat(settings.screenshotScale);
    if (!isNaN(loadedScale) && loadedScale > 0) {
        config.domToImageOptions.scale = loadedScale;
    } else {
        config.domToImageOptions.scale = defaultSettings.screenshotScale;
    }

    config.domToImageOptions.useForeignObject = settings.useForeignObjectRendering; // dom-to-image-more 应该有类似选项，如 useForeignObject
    config.domToImageOptions.imageTimeout = settings.imageTimeout || defaultSettings.imageTimeout;
    config.domToImageOptions.cacheBust = settings.cacheBust !== undefined ? settings.cacheBust : defaultSettings.cacheBust;
    
    console.log(`${PLUGIN_NAME}: 配置已加载并应用:`, config);

    config.autoInstallButtons = settings.autoInstallButtons;
}

// === 动态加载脚本的辅助函数 (保持在 jQuery 闭包外部) ===
async function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
            console.log(`[${PLUGIN_NAME}] 脚本加载成功: ${src}`);
            resolve();
        };
        script.onerror = (error) => {
            console.error(`[${PLUGIN_NAME}] 脚本加载失败: ${src}`, error);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
}

// {{ edit_1: 添加字体预加载并内联函数 }}
async function inlineFonts(cssUrl) {
    try {
        const cssText = await (await fetch(cssUrl)).text();
        // 提取所有 url(...) 链接
        const fontUrls = Array.from(cssText.matchAll(/url\(["']?([^)"']+)["']?\)/g), m => m[1]);
        const uniqueUrls = [...new Set(fontUrls)];
        let inlinedCss = cssText;
        await Promise.all(uniqueUrls.map(async url => {
            try {
                const resp = await fetch(url);
                const buf = await resp.arrayBuffer();
                const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                const mime = resp.headers.get('content-type') || 'font/woff2';
                const dataUrl = `data:${mime};base64,${b64}`;
                // 替换所有原始 URL
                inlinedCss = inlinedCss.split(url).join(dataUrl);
            } catch (e) {
                console.error(`${PLUGIN_NAME}: 字体内联失败 ${url}`, e);
            }
        }));
        const styleEl = document.createElement('style');
        styleEl.textContent = inlinedCss;
        document.head.appendChild(styleEl);
        console.log(`${PLUGIN_NAME}: 字体内联完成`);
    } catch (e) {
        console.error(`${PLUGIN_NAME}: 字体预加载失败`, e);
    }
}

// SillyTavern 插件入口点
jQuery(async () => {
    console.log(`${PLUGIN_NAME}: 等待字体加载…`);
    if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
        console.log(`${PLUGIN_NAME}: 字体加载完成`);
    }
    // 再继续 loadScript/dom-to-image 以及剩下的初始化、截图逻辑

    console.log(`${PLUGIN_NAME}: 插件初始化中...`);

    // === 动态加载 dom-to-image-more.min.js ===
    try {
        // === 重点修改这里的路径 ===
        // 确保你已经将 dom-to-image-more.min.js 放在此路径
        await loadScript(`scripts/extensions/third-party/${PLUGIN_ID}/dom-to-image-more.min.js`);
        if (typeof domtoimage === 'undefined') {
            throw new Error('domtoimage global object not found after loading script.');
        }
    } catch (error) {
        console.error(`${PLUGIN_NAME}: 无法加载 dom-to-image-more.min.js。插件功能将受限。`, error);
        // 可以选择弹窗提示用户
        // alert(`${PLUGIN_NAME}: 核心库 dom-to-image-more.min.js 加载失败，截图功能不可用。请检查文件路径或网络连接。`);
        return;
    }

    // 1. 加载配置（从 extension_settings）
    loadConfig();

    // 2. 注册设置面板
    let settingsHtml;
    try {
        settingsHtml = await renderExtensionTemplateAsync(`third-party/${PLUGIN_ID}`, 'settings');
        console.log(`${PLUGIN_NAME}: 成功加载设置面板模板`);
    } catch (error) {
        console.error(`${PLUGIN_NAME}: 无法加载设置面板模板:`, error);
        settingsHtml = `
        <div id="scane2_settings">
          <h2>${PLUGIN_NAME}</h2>

          <div class="option-group">
            <h3>截图操作</h3>
            <button id="st_h2c_captureLastMsgBtn" class="menu_button">截取最后一条消息</button>
          </div>

          <hr>

          <div class="option-group">
            <h3>扩展设置</h3>
            <div class="option">
              <label for="st_h2c_screenshotDelay">截图前延迟 (ms):</label>
              <input type="number" id="st_h2c_screenshotDelay" min="0" max="2000" step="50" value="${defaultSettings.screenshotDelay}">
            </div>
            <div class="option">
              <label for="st_h2c_screenshotScale">渲染比例 (Scale):</label>
              <input type="number" id="st_h2c_screenshotScale" min="0.5" max="4.0" step="0.1" value="${defaultSettings.screenshotScale}">
            </div>
            <div class="option">
                <label for="st_h2c_imageTimeout">图像加载超时 (ms):</label>
                <input type="number" id="st_h2c_imageTimeout" min="0" max="30000" step="1000" value="${defaultSettings.imageTimeout}">
            </div>
            <div class="option">
                <input type="checkbox" id="st_h2c_useForeignObjectRendering" ${defaultSettings.useForeignObjectRendering ? 'checked' : ''}>
                <label for="st_h2c_useForeignObjectRendering">尝试SVG对象渲染 (某些浏览器/内容可能更快)</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_cacheBust" ${defaultSettings.cacheBust ? 'checked' : ''}>
              <label for="st_h2c_cacheBust">清除图片缓存 (用于CORS图片)</label>
            </div>
            
            <!-- 以下三个设置从UI中移除，但在代码中保留功能 -->
            <input type="hidden" id="st_h2c_autoInstallButtons" ${defaultSettings.autoInstallButtons ? 'checked' : ''}>
            <input type="hidden" id="st_h2c_altButtonLocation" ${defaultSettings.altButtonLocation ? 'checked' : ''}>
            <input type="hidden" id="st_h2c_debugOverlay" ${defaultSettings.debugOverlay ? 'checked' : ''}>

            <button id="st_h2c_saveSettingsBtn" class="menu_button">保存设置</button>
            <div class="status-area" id="st_h2c_saveStatus" style="display:none;"></div>
          </div>
        </div>
        `;
    }

    $('#extensions_settings_content').append(settingsHtml);

    // 3. 绑定设置界面元素和事件
    const settingsForm = $('#extensions_settings_content');

    const screenshotDelayEl = settingsForm.find('#st_h2c_screenshotDelay');
    const screenshotScaleEl = settingsForm.find('#st_h2c_screenshotScale');
    const useForeignObjectRenderingEl = settingsForm.find('#st_h2c_useForeignObjectRendering');
    const autoInstallButtonsEl = settingsForm.find('#st_h2c_autoInstallButtons');
    const altButtonLocationEl = settingsForm.find('#st_h2c_altButtonLocation');
    const saveSettingsBtn = settingsForm.find('#st_h2c_saveSettingsBtn');
    const saveStatusEl = settingsForm.find('#st_h2c_saveStatus');
    const captureLastMsgBtn = settingsForm.find('#st_h2c_captureLastMsgBtn');
    const imageTimeoutEl = settingsForm.find('#st_h2c_imageTimeout');
    const cacheBustEl = settingsForm.find('#st_h2c_cacheBust');
    const debugOverlayEl = settingsForm.find('#st_h2c_debugOverlay');

    function updateSettingsUI() {
        const settings = getPluginSettings();
        screenshotDelayEl.val(settings.screenshotDelay);
        screenshotScaleEl.val(settings.screenshotScale);
        useForeignObjectRenderingEl.prop('checked', settings.useForeignObjectRendering);
        autoInstallButtonsEl.prop('checked', settings.autoInstallButtons);
        altButtonLocationEl.prop('checked', settings.altButtonLocation !== undefined ? settings.altButtonLocation : true);
        
        if (imageTimeoutEl) imageTimeoutEl.val(settings.imageTimeout);
        if (cacheBustEl) cacheBustEl.prop('checked', settings.cacheBust);
        if (debugOverlayEl) debugOverlayEl.prop('checked', settings.debugOverlay);
    }

    saveSettingsBtn.on('click', () => {
        const settings = getPluginSettings();

        settings.screenshotDelay = parseInt(screenshotDelayEl.val(), 10) || defaultSettings.screenshotDelay;
        settings.screenshotScale = parseFloat(screenshotScaleEl.val()) || defaultSettings.screenshotScale;
        settings.useForeignObjectRendering = useForeignObjectRenderingEl.prop('checked');
        settings.autoInstallButtons = autoInstallButtonsEl.prop('checked');
        settings.altButtonLocation = altButtonLocationEl.prop('checked');
        settings.imageTimeout = parseInt(imageTimeoutEl.val(), 10) || defaultSettings.imageTimeout;
        settings.cacheBust = cacheBustEl.prop('checked');
        settings.debugOverlay = debugOverlayEl.prop('checked');

        saveSettingsDebounced();
        saveStatusEl.text("设置已保存!").css('color', '#4cb944').show();
        setTimeout(() => saveStatusEl.hide(), 1000);

        loadConfig();
        if (config.autoInstallButtons) {
            installScreenshotButtons();
        } else {
            document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
        }
		$('#extensions_settings').hide();     // SillyTavern 本体的设置侧栏
    });

    captureLastMsgBtn.on('click', async () => {
        const options = { target: 'last', includeHeader: true };
        try {
            const dataUrl = await captureMessageWithOptions(options);
            if (dataUrl) {
                downloadImage(dataUrl, null, options.target);
            } else {
                throw new Error('未能生成截图 (dom-to-image)');
            }
        } catch (error) {
            console.error('从设置面板截图失败 (dom-to-image):', error.stack || error);
            alert(`截图失败: ${error.message || '未知错误'}`);
        }
    });

    updateSettingsUI();

    if (config.autoInstallButtons) {
        installScreenshotButtons();
    } else {
        console.log(`${PLUGIN_NAME}: 自动安装截图按钮已禁用.`);
    }

    console.log(`${PLUGIN_NAME}: 插件初始化完成.`);

    // 创建并添加扩展菜单按钮 (与原脚本相同)
    function addExtensionMenuButton() {
        if (document.querySelector(`#extensionsMenu .fa-camera[data-plugin-id="${PLUGIN_ID}"]`)) {
            return;
        }
        const menuButton = document.createElement('div');
        menuButton.classList.add('extensionsMenuExtension');
    
        // 1) 图标
        const icon = document.createElement('i');
        icon.classList.add('fa-solid', 'fa-camera');
        menuButton.appendChild(icon);
    
        // 2) 文本标签
        menuButton.appendChild(document.createTextNode('截图设置'));
        menuButton.title = PLUGIN_NAME;
        menuButton.setAttribute('data-plugin-id', PLUGIN_ID);
        menuButton.addEventListener('click', () => {
            const extensionsMenu = document.getElementById('extensionsMenu');
            if (extensionsMenu) extensionsMenu.style.display = 'none';
            showScreenshotPopup();
        });
        const extensionsMenu = document.getElementById('extensionsMenu');
        if (extensionsMenu) {
            extensionsMenu.appendChild(menuButton);
        }
    }

    // 显示截图功能弹窗 (与原脚本相同, 仅更新插件名和错误信息)
    function showScreenshotPopup() {
        const overlay = document.createElement('div');
        overlay.className = 'st-screenshot-overlay';
        Object.assign(overlay.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', zIndex: '10000', display: 'flex', justifyContent: 'center', alignItems:'flex-start' });

        const popup = document.createElement('div');
        popup.className = 'st-screenshot-popup';
        const bgColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBlurTintColor') || '#2a2a2a';
        const boxBorderColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBorderColor') || '#555';
        Object.assign(popup.style, { 
            backgroundColor: bgColor.trim(), 
            border: `1px solid ${boxBorderColor.trim()}`,
            padding: '20px', 
            borderRadius: '10px', 
            maxWidth: '300px', 
            marginTop: '35vh', 
            width: '100%', 
            overflowY: 'auto'
        });

        const options = [
            { id: 'last_msg', icon: 'fa-camera', text: '截取最后一条消息' },
            { id: 'conversation', icon: 'fa-images', text: '截取整个对话' },
            { id: 'settings', icon: 'fa-gear', text: '调整截图设置' }
        ];
        
        options.forEach(option => {
            const btn = document.createElement('div');
            btn.className = 'st-screenshot-option';
            const btnBgColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBorderColor') || '#3a3a3a';
            const menuHoverColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBlurTintStrength') || '#4a4a4a';
            Object.assign(btn.style, { 
                display: 'flex', 
                alignItems: 'center', 
                gap: '10px', 
                padding: '12px', 
                margin: '8px 0', 
                borderRadius: '5px', 
                cursor: 'pointer', 
                backgroundColor: btnBgColor.trim() 
            });
            
            btn.innerHTML = `<i class="fa-solid ${option.icon}" style="font-size: 1.2em;"></i><span>${option.text}</span>`;
            
            btn.addEventListener('mouseover', () => btn.style.backgroundColor = menuHoverColor.trim());
            btn.addEventListener('mouseout', () => btn.style.backgroundColor = btnBgColor.trim());
            
            btn.addEventListener('click', async () => {
                console.log(`[${PLUGIN_NAME}] ${option.id} clicked`);
                document.body.removeChild(overlay);
                
                try {
                    switch(option.id) {
                        case 'last_msg':
                            const dataUrl = await captureMessageWithOptions({ target: 'last', includeHeader: true });
                            if (dataUrl) downloadImage(dataUrl, null, 'last_message');
                            break;
                        case 'conversation':
                            const convDataUrl = await captureMessageWithOptions({ target: 'conversation', includeHeader: true });
                            if (convDataUrl) downloadImage(convDataUrl, null, 'conversation');
                            break;
                        case 'settings':
                            showSettingsPopup(); // 这个函数也需要更新
                            break;
                    }
                } catch (error) {
                    console.error(`[${PLUGIN_NAME}] 操作失败:`, error);
                    alert(`操作失败 (dom-to-image): ${error.message || '未知错误'}`);
                }
            });
            popup.appendChild(btn);
        });
        
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
    }

    function waitForExtensionsMenu() {
        if (document.getElementById('extensionsMenu')) {
            addExtensionMenuButton();
            return;
        }
        const observer = new MutationObserver((mutations, obs) => {
            if (document.getElementById('extensionsMenu')) {
                addExtensionMenuButton();
                obs.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    waitForExtensionsMenu();
});


function prepareSingleElementForCapture(originalElement) {
  // 克隆元素
  const clonedElement = originalElement.cloneNode(true);
  
  // 找到所有消息元素
  const messageElements = clonedElement.querySelectorAll('.mes');
  
  // 遍历每个消息元素，设置背景为透明
  messageElements.forEach(message => {
    // 创建一个新的样式元素
    const style = document.createElement('style');
    style.textContent = `
      .mes {
        background: transparent !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .mes_block {
        background: transparent !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .mes_text {
        background: transparent !important;
      }
      .mes_header {
        background: transparent !important;
      }
      .mes_content {
        background: transparent !important;
      }
    `;
    
    // 将样式添加到克隆的元素中
    clonedElement.appendChild(style);
  });
  
  return clonedElement;
}

// 核心截图函数：使用 dom-to-image-more
// Renamed from captureElementWithHtml2Canvas
async function captureElementWithDomToImage(elementToCapture, dtiUserOptions = {}) {
    console.log('Preparing to capture element with dom-to-image-more:', elementToCapture);
    
    let overlay = null;
    if (config.debugOverlay) {
        overlay = createOverlay('使用 dom-to-image-more 准备截图...');
        document.body.appendChild(overlay);
    }
    
    // elementsToHide 和 originalDisplays 实际上在这种策略下可能不再需要，
    // 因为我们是截图一个离屏的、干净的临时容器。
    // 但为了以防万一，或者如果将来需要隐藏某些全局元素，暂时保留。
    const elementsToHide = [
        document.querySelector("#top-settings-holder"),
        document.querySelector("#form_sheld"),
        overlay
    ].filter(el => el);
    // const originalDisplays = new Map(); // 如果不主动隐藏，这个就不需要了

    let dataUrl = null;

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px'; // Off-screen
    tempContainer.style.top = '-9999px';
    tempContainer.style.padding = '10px'; // Padding around the content

    const chatContentEl = document.querySelector(config.chatContentSelector);
    let containerWidth = 'auto';
    if (chatContentEl) {
        containerWidth = chatContentEl.clientWidth + 'px';
    } else if (elementToCapture) {
        containerWidth = elementToCapture.offsetWidth + 'px';
    }
    tempContainer.style.width = containerWidth;

    tempContainer.style.backgroundColor = 'transparent';

    let preparedElement;
    try {
        if (overlay) updateOverlay(overlay, '准备元素结构...', 0.05);
        // prepareSingleElementForCapture 负责克隆和净化，移除消息内部不需要的元素
        preparedElement = prepareSingleElementForCapture(elementToCapture);
        if (!preparedElement) throw new Error("Failed to prepare element for capture.");

        tempContainer.appendChild(preparedElement);
        document.body.appendChild(tempContainer);

        if (config.screenshotDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, config.screenshotDelay));
        }

    } catch (e) {
        console.error("Error during element preparation (dom-to-image):", e);
        if (overlay && document.body.contains(overlay)) {
             updateOverlay(overlay, `净化错误: ${e.message.substring(0, 60)}...`, 0);
        }
        if (tempContainer.parentElement === document.body) {
           document.body.removeChild(tempContainer);
        }
        throw e;
    }

    try {
        if (overlay) updateOverlay(overlay, '正在渲染 (dom-to-image)...', 0.3);
        
        const finalDomToImageOptions = { ...config.domToImageOptions, ...dtiUserOptions };
        
        // **** 移除了 filter 选项的设置 ****
        // 因为 prepareSingleElementForCapture 已经处理了元素内部的净化,
        // 并且我们是截图一个包含净化后元素的临时容器。

        console.log('dom-to-image opts (no filter):', finalDomToImageOptions);
        
        // 使用临时容器进行渲染
        dataUrl = await domtoimage.toPng(tempContainer, {
            ...finalDomToImageOptions,
            bgcolor: null,
            style: {
                'background-color': 'transparent'
            }
        });
        
        if (overlay) updateOverlay(overlay, '生成图像数据...', 0.8);

    } catch (error) {
        console.error('dom-to-image 截图失败:', error.stack || error);
        if (overlay && document.body.contains(overlay)) {
             const errorMsg = error && error.message ? error.message : "未知渲染错误";
             updateOverlay(overlay, `渲染错误 (dom-to-image): ${errorMsg.substring(0, 60)}...`, 0);
        }
        throw error;
    } finally {
        if (tempContainer.parentElement === document.body) {
           document.body.removeChild(tempContainer);
        }
        if (overlay && document.body.contains(overlay)) {
            if (!dataUrl) {
                setTimeout(() => { if(document.body.contains(overlay)) document.body.removeChild(overlay); }, 3000);
            } else {
               updateOverlay(overlay, '截图完成!', 1);
               setTimeout(() => { if(document.body.contains(overlay)) document.body.removeChild(overlay); }, 1200);
            }
        }
    }
    if (!dataUrl) throw new Error("dom-to-image 未能生成图像数据。");
    console.log("DEBUG: dom-to-image capture successful.");
    return dataUrl;
}

// Capture multiple messages using dom-to-image-more
// Renamed from captureMultipleMessagesWithHtml2Canvas
async function captureMultipleMessagesWithDomToImage(messagesToCapture, actionHint, dtiUserOptions = {}) {
    if (!messagesToCapture || messagesToCapture.length === 0) {
        throw new Error("没有提供消息给 captureMultipleMessagesWithDomToImage");
    }
    console.log(`[captureMultipleMessagesWithDomToImage] Capturing ${messagesToCapture.length} messages. Hint: ${actionHint}`);

    const overlay = createOverlay(`组合 ${messagesToCapture.length} 条消息 (dom-to-image)...`);
    document.body.appendChild(overlay);

    let dataUrl = null;
    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '-9999px';
    tempContainer.style.padding = '10px';

    const chatContentEl = document.querySelector(config.chatContentSelector);
    let containerWidth = 'auto';
    if (chatContentEl) {
        containerWidth = chatContentEl.clientWidth + 'px';
    } else if (messagesToCapture.length > 0 && messagesToCapture[0].offsetWidth > 0) {
        containerWidth = messagesToCapture[0].offsetWidth + 'px';
    } else {
        containerWidth = '800px'; 
        console.warn("Could not determine container width for multi-message capture, using fallback.");
    }
    tempContainer.style.width = containerWidth;

    // 将背景设置为透明
    tempContainer.style.backgroundColor = 'transparent';

    updateOverlay(overlay, `准备 ${messagesToCapture.length} 条消息 (dom-to-image)...`, 0.05);
    messagesToCapture.forEach(msg => {
        try {
            // prepareSingleElementForCapture 负责克隆和净化每个消息元素
            const preparedClone = prepareSingleElementForCapture(msg);
            if (preparedClone) {
                tempContainer.appendChild(preparedClone);
            } else {
                 console.warn("Skipping null prepared clone for message:", msg);
            }
        } catch (e) {
            console.error("Error preparing message for multi-capture (dom-to-image):", msg, e);
        }
    });
    document.body.appendChild(tempContainer);
    await new Promise(resolve => setTimeout(resolve, config.screenshotDelay)); // Allow render

    try {
        updateOverlay(overlay, '正在渲染 (dom-to-image)…', 0.3);

        const finalDomToImageOptions = { ...config.domToImageOptions, ...dtiUserOptions };
        
        console.log("DEBUG: dom-to-image (multiple) options (no filter):", finalDomToImageOptions);
        
        // 添加透明背景配置
        dataUrl = await domtoimage.toPng(tempContainer, {
            ...finalDomToImageOptions,
            bgcolor: null,
            style: {
                'background-color': 'transparent'
            }
        });

        updateOverlay(overlay, '生成图像数据...', 0.8);

    } catch (error) {
        console.error('dom-to-image 多消息截图失败:', error.stack || error);
         if (overlay && document.body.contains(overlay)) {
             const errorMsg = error && error.message ? error.message : "未知渲染错误";
             updateOverlay(overlay, `多消息渲染错误 (dom-to-image): ${errorMsg.substring(0,50)}...`, 0);
        }
        throw error;
    } finally {
        if (tempContainer.parentElement === document.body) {
            document.body.removeChild(tempContainer);
        }
        if (overlay && document.body.contains(overlay)) {
            if (!dataUrl) {
                 setTimeout(() => {if(document.body.contains(overlay)) document.body.removeChild(overlay);}, 3000);
            } else {
                updateOverlay(overlay, '截图完成!', 1);
                setTimeout(() => {if(document.body.contains(overlay)) document.body.removeChild(overlay);}, 1200);
            }
        }
    }
    if (!dataUrl) throw new Error("dom-to-image 未能生成多消息图像数据。");
    console.log("DEBUG: dom-to-image multiple messages capture successful.");
    return dataUrl;
}


// Routes capture requests, now calls dom-to-image functions
async function captureMessageWithOptions(options) {
    const { target, includeHeader } = options;
    console.log('captureMessageWithOptions (dom-to-image) called with:', options);

    const chatContentEl = document.querySelector(config.chatContentSelector);
    if (!chatContentEl) {
         const errorMsg = `聊天内容容器 '${config.chatContentSelector}' 未找到!`;
         console.error(`${PLUGIN_NAME}:`, errorMsg);
         throw new Error(errorMsg);
    }

    let elementToRender;
    let messagesForMultiCapture = [];

    switch (target) {
        case 'last':
            elementToRender = chatContentEl.querySelector(config.lastMessageSelector);
            if (!elementToRender) throw new Error('最后一条消息元素未找到');
            break;
        case 'selected':
            elementToRender = chatContentEl.querySelector(`${config.messageSelector}[data-selected="true"]`) || chatContentEl.querySelector(`${config.messageSelector}.selected`);
            if (!elementToRender) throw new Error('没有选中的消息');
            break;
        case 'conversation':
            messagesForMultiCapture = Array.from(chatContentEl.querySelectorAll(config.messageSelector));
            if (messagesForMultiCapture.length === 0) throw new Error("对话中没有消息可捕获。");
            return await captureMultipleMessagesWithDomToImage(messagesForMultiCapture, "conversation_all", {}); // Updated call
        default:
            throw new Error('未知的截图目标类型');
    }

    if (!elementToRender && messagesForMultiCapture.length === 0) {
         throw new Error(`目标元素未找到 (for ${target} within ${config.chatContentSelector})`);
    }

    if (elementToRender) {
        let finalElementToCapture = elementToRender;
        if (!includeHeader && target !== 'conversation' && elementToRender.querySelector(config.messageTextSelector)) {
            const textElement = elementToRender.querySelector(config.messageTextSelector);
            if (textElement) {
                finalElementToCapture = textElement;
                console.log('Capturing text element only with dom-to-image:', finalElementToCapture);
            } else {
                console.warn("Could not find text element for includeHeader: false, capturing full message.");
            }
        }
        return await captureElementWithDomToImage(finalElementToCapture, {}); // Updated call
    }
    throw new Error("captureMessageWithOptions (dom-to-image): Unhandled capture scenario.");
}

// Installs screenshot buttons (largely same, just updates error messages/logs if any)
function installScreenshotButtons() {
    document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());

    const chatContentEl = document.querySelector(config.chatContentSelector);
    if (chatContentEl) {
        chatContentEl.querySelectorAll(config.messageSelector).forEach(message => addScreenshotButtonToMessage(message));
    } else {
        console.warn(`${PLUGIN_NAME}: Chat content ('${config.chatContentSelector}') not found for initial button installation.`);
        return false;
    }

    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.matches(config.messageSelector)) {
                addScreenshotButtonToMessage(node);
              } else if (node.querySelectorAll) {
                node.querySelectorAll(config.messageSelector).forEach(addScreenshotButtonToMessage);
              }
            }
          });
        }
      });
    });

    observer.observe(chatContentEl, { childList: true, subtree: true });
    console.log(`${PLUGIN_NAME}: 截图按钮安装逻辑已执行.`);
    return true;
}

// Adds a screenshot button (updated calls in click handler)
function addScreenshotButtonToMessage(messageElement) {
    if (!messageElement || !messageElement.querySelector || messageElement.querySelector(`.${config.buttonClass}`)) {
      return;
    }

    let buttonsContainer = messageElement.querySelector('.mes_block .ch_name.flex-container.justifySpaceBetween .mes_buttons');
    if (!buttonsContainer) {
      buttonsContainer = messageElement.querySelector('.mes_block .mes_buttons');
      if (!buttonsContainer) {
        return;
      }
    }

    const screenshotButton = document.createElement('div');
    screenshotButton.innerHTML = '<i class="fa-solid fa-camera"></i>';
    screenshotButton.className = `${config.buttonClass} mes_button interactable`; 
    screenshotButton.title = '截图此消息 (长按显示更多选项)';
    screenshotButton.setAttribute('tabindex', '0');
    screenshotButton.style.cursor = 'pointer';

    const contextMenu = document.createElement('div');
    contextMenu.className = 'st-screenshot-context-menu';
    const bgColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBorderColor') || '#555';
    const menuHoverColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBlurTintStrength') || '#4a4a4a';
    Object.assign(contextMenu.style, { display: 'none', position: 'absolute', zIndex: '10000', background: bgColor.trim(), border: `1px solid ${bgColor.trim()}`, borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.3)', padding: '5px 0' });

    const menuOptions = [
      { text: '截取前四条消息', action: 'prev4' }, { text: '截取前三条消息', action: 'prev3' },
      { text: '截取前两条消息', action: 'prev2' }, { text: '截取前一条消息', action: 'prev1' },
      { text: '截取后一条消息', action: 'next1' }, { text: '截取后两条消息', action: 'next2' },
      { text: '截取后三条消息', action: 'next3' }, { text: '截取后四条消息', action: 'next4' }
    ];

    menuOptions.forEach(option => {
      const menuItem = document.createElement('div');
      menuItem.className = 'st-screenshot-menu-item';
      menuItem.textContent = option.text;
      const btnBgColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBorderColor') || '#3a3a3a';
      Object.assign(menuItem.style, { padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background-color 0.2s', backgroundColor: btnBgColor.trim() });
      menuItem.onmouseover = () => menuItem.style.backgroundColor = menuHoverColor.trim();
      menuItem.onmouseout = () => menuItem.style.backgroundColor = btnBgColor.trim();
      menuItem.onclick = async (e) => {
        e.stopPropagation(); 
        hideContextMenu();
        await captureMultipleMessagesFromContextMenu(messageElement, option.action); // Calls the updated multi-capture
      };
      contextMenu.appendChild(menuItem);
    });
    document.body.appendChild(contextMenu);

    let pressTimer, isLongPress = false;
    function showContextMenu(x, y) {
      contextMenu.style.display = 'block';
      const vpW = window.innerWidth, vpH = window.innerHeight;
      const menuW = contextMenu.offsetWidth, menuH = contextMenu.offsetHeight;
      if (x + menuW > vpW) x = vpW - menuW - 5;
      if (y + menuH > vpH) y = vpH - menuH - 5;
      if (y < 0) y = 5;
      contextMenu.style.left = `${x}px`; contextMenu.style.top = `${y}px`;
    }
    function hideContextMenu() { contextMenu.style.display = 'none'; }

    screenshotButton.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true; const rect = screenshotButton.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 5);
      }, 500);
    });
    screenshotButton.addEventListener('mouseup', () => clearTimeout(pressTimer));
    screenshotButton.addEventListener('mouseleave', () => clearTimeout(pressTimer));
    screenshotButton.addEventListener('touchstart', (e) => {
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true; const rect = screenshotButton.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 5);
      }, 500);
    });
    screenshotButton.addEventListener('touchend', () => clearTimeout(pressTimer));
    screenshotButton.addEventListener('touchcancel', () => clearTimeout(pressTimer));
    document.addEventListener('click', (e) => {
      if (contextMenu.style.display === 'block' && !contextMenu.contains(e.target) && !screenshotButton.contains(e.target)) {
          hideContextMenu();
      }
    });
    screenshotButton.addEventListener('contextmenu', (e) => e.preventDefault());

    screenshotButton.addEventListener('click', async function(event) {
      event.preventDefault(); event.stopPropagation();
      if (isLongPress) { isLongPress = false; return; }
      if (this.classList.contains('loading')) return;

      const iconElement = this.querySelector('i');
      const originalIconClass = iconElement ? iconElement.className : '';
      if (iconElement) iconElement.className = `fa-solid fa-spinner fa-spin ${config.buttonClass}-icon-loading`;
      this.classList.add('loading');

      try {
        const dataUrl = await captureElementWithDomToImage(messageElement, {}); // Updated call
        downloadImage(dataUrl, messageElement, 'message');
      } catch (error) {
        console.error('消息截图失败 (dom-to-image button click):', error.stack || error);
        alert(`截图失败: ${error.message || '未知错误'}`);
      } finally {
        if (iconElement) iconElement.className = originalIconClass;
        this.classList.remove('loading');
      }
    });

    const extraMesButtons = buttonsContainer.querySelector('.extraMesButtons.visible');
    const editButton = buttonsContainer.querySelector('.mes_button.mes_edit.fa-solid.fa-pencil.interactable');
    if (extraMesButtons && editButton) {
      editButton.insertAdjacentElement('beforebegin', screenshotButton);
    } else {
      const existingButton = buttonsContainer.querySelector('.fa-edit, .mes_edit');
      if (existingButton) {
        existingButton.insertAdjacentElement('beforebegin', screenshotButton);
      } else {
        buttonsContainer.appendChild(screenshotButton);
      }
    }
}

// Handles context menu actions (updated calls)
async function captureMultipleMessagesFromContextMenu(currentMessageElement, action) {
    console.log(`[多消息截图 ctx menu dom-to-image] Action: ${action} from msg:`, currentMessageElement);
    const button = currentMessageElement.querySelector(`.${config.buttonClass}`);
    const iconElement = button ? button.querySelector('i') : null;
    const originalIconClass = iconElement ? iconElement.className : '';

    if (button) button.classList.add('loading');
    if (iconElement) iconElement.className = `fa-solid fa-spinner fa-spin ${config.buttonClass}-icon-loading`;

    try {
        const chatContent = document.querySelector(config.chatContentSelector);
        if (!chatContent) throw new Error(`无法进行多消息截图，聊天内容容器 '${config.chatContentSelector}' 未找到!`);
        
        let allMessages = Array.from(chatContent.querySelectorAll(config.messageSelector));
        let currentIndex = allMessages.indexOf(currentMessageElement);
        if (currentIndex === -1) throw new Error('无法确定当前消息位置');

        let startIndex = currentIndex, endIndex = currentIndex;
        switch (action) {
            case 'prev4': startIndex = Math.max(0, currentIndex - 4); break;
            case 'prev3': startIndex = Math.max(0, currentIndex - 3); break;
            case 'prev2': startIndex = Math.max(0, currentIndex - 2); break;
            case 'prev1': startIndex = Math.max(0, currentIndex - 1); break;
            case 'next1': endIndex = Math.min(allMessages.length - 1, currentIndex + 1); break;
            case 'next2': endIndex = Math.min(allMessages.length - 1, currentIndex + 2); break;
            case 'next3': endIndex = Math.min(allMessages.length - 1, currentIndex + 3); break;
            case 'next4': endIndex = Math.min(allMessages.length - 1, currentIndex + 4); break;
            default: throw new Error(`未知多消息截图动作: ${action}`);
        }

        const targetMessages = allMessages.slice(startIndex, endIndex + 1);
        if (targetMessages.length === 0) throw new Error('无法获取目标消息进行多条截图');

        const dataUrl = await captureMultipleMessagesWithDomToImage(targetMessages, action, {}); // Updated call

        if (dataUrl) {
            const actionTextMap = { 'prev4':'前四条', 'prev3':'前三条', 'prev2':'前两条', 'prev1':'前一条', 'next1':'后一条', 'next2':'后两条', 'next3':'后三条', 'next4':'后四条' };
            const fileNameHint = `ST消息组_${actionTextMap[action] || action}`;
            downloadImage(dataUrl, currentMessageElement, fileNameHint);
        } else {
            throw new Error('多消息截图 dom-to-image 生成失败');
        }
    } catch (error) {
        console.error(`[多消息截图 ctx menu dom-to-image] 失败 (${action}):`, error.stack || error);
        alert(`截图 (${action}) 失败: ${error.message || '未知错误'}`);
    } finally {
        if (iconElement) iconElement.className = originalIconClass;
        if (button) button.classList.remove('loading');
    }
}


// Utility function to download (same as original)
function downloadImage(dataUrl, messageElement = null, typeHint = 'screenshot') {
    const link = document.createElement('a');
    let filename = `SillyTavern_${typeHint.replace(/[^a-z0-9_-]/gi, '_')}`;
    if (messageElement && typeof messageElement.querySelector === 'function') {
      const nameSelector = config.messageHeaderSelector + ' .name_text';
      const nameFallbackSelector = config.messageHeaderSelector;
      const nameTextElement = messageElement.querySelector(nameSelector) || messageElement.querySelector(nameFallbackSelector);
      let senderName = 'Character';
      if (nameTextElement && nameTextElement.textContent) {
          senderName = nameTextElement.textContent.trim() || 'Character';
      }
      const isUser = messageElement.classList.contains('user_mes') || (messageElement.closest && messageElement.closest('.user_mes'));
      const sender = isUser ? 'User' : senderName;
      const msgIdData = messageElement.getAttribute('mesid') || messageElement.dataset.msgId || messageElement.id;
      const msgId = msgIdData ? msgIdData.slice(-5) : ('m' + Date.now().toString().slice(-8, -4));
      const timestampAttr = messageElement.dataset.timestamp || messageElement.getAttribute('data-timestamp') || new Date().toISOString();
      const timestamp = timestampAttr.replace(/[:\sTZ.]/g, '_').replace(/__+/g, '_');
      const filenameSafeSender = sender.replace(/[^a-z0-9_-]/gi, '_').substring(0, 20);
      filename = `SillyTavern_${filenameSafeSender}_${msgId}_${timestamp}`;
    } else {
      filename += `_${new Date().toISOString().replace(/[:.TZ]/g, '-')}`;
    }
    link.download = `${filename}.png`;
    link.href = dataUrl;
    link.click();
    console.log(`Image downloaded as ${filename}.png`);
}

// Utility to create overlay (same as original)
function createOverlay(message) {
    const overlay = document.createElement('div');
    overlay.className = 'st-capture-overlay';
    const statusBox = document.createElement('div');
    statusBox.className = 'st-capture-status';
    const messageP = document.createElement('p');
    messageP.textContent = message;
    statusBox.appendChild(messageP);
    const progressContainer = document.createElement('div');
    progressContainer.className = 'st-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'st-progress-bar';
    progressBar.style.width = '0%';
    progressContainer.appendChild(progressBar);
    statusBox.appendChild(progressContainer);
    overlay.appendChild(statusBox);
    return overlay;
}

// Utility to update overlay (same as original)
function updateOverlay(overlay, message, progressRatio) {
    if (!overlay || !overlay.parentNode) return;
    const messageP = overlay.querySelector('.st-capture-status p');
    const progressBar = overlay.querySelector('.st-progress-bar');
    if (messageP) messageP.textContent = message;
    const safeProgress = Math.max(0, Math.min(1, progressRatio));
    if (progressBar) progressBar.style.width = `${Math.round(safeProgress * 100)}%`;
}

// 自定义设置弹窗 (与原脚本类似，更新了部分标签和选项)
function showSettingsPopup() {
    const settings = getPluginSettings();
    
    const overlay = document.createElement('div');
    overlay.className = 'st-settings-overlay';
    Object.assign(overlay.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', zIndex: '10000', display: 'flex', justifyContent: 'center', maxHeight:'90vh', alignItems:'flex-start' });

    const popup = document.createElement('div');
    popup.className = 'st-settings-popup';
    const bgColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBlurTintColor') || '#2a2a2a';
    const boxBorderColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBorderColor') || '#555';
    Object.assign(popup.style, { 
        backgroundColor: bgColor.trim(), 
        border: `1px solid ${boxBorderColor.trim()}`,
        padding: '20px', 
        borderRadius: '10px', 
        maxWidth: '400px', 
        width: '100%', 
        maxHeight: '80vh', 
        marginTop: '30vh', 
        overflowY: 'auto'
    });
    
    const title = document.createElement('h3');
    title.textContent = '截图设置';
    Object.assign(title.style, { marginTop: '0', marginBottom: '15px', textAlign: 'center' });
    popup.appendChild(title);
    
    const settingsConfig = [
        { id: 'screenshotDelay', type: 'number', label: '截图前延迟 (ms)', min: 0, max: 2000, step: 50 },
        { id: 'screenshotScale', type: 'number', label: '渲染比例 (Scale)', min: 0.5, max: 4.0, step: 0.1 },
        { id: 'imageTimeout', type: 'number', label: '图像加载超时 (ms)', min: 0, max: 30000, step: 1000 },
        { id: 'useForeignObjectRendering', type: 'checkbox', label: '尝试SVG对象渲染' },
        { id: 'cacheBust', type: 'checkbox', label: '清除图片缓存' }
    ];
    
    settingsConfig.forEach(setting => {
        const settingContainer = document.createElement('div');
        Object.assign(settingContainer.style, { margin: '10px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
        
        const label = document.createElement('label');
        label.textContent = setting.label;
        label.style.marginRight = '10px';
        settingContainer.appendChild(label);
        
        let input;
        if (setting.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `st_setting_popup_${setting.id}`; // Ensure unique IDs for popup
            input.checked = settings[setting.id];
        } else if (setting.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.id = `st_setting_popup_${setting.id}`;
            input.min = setting.min;
            input.max = setting.max;
            input.step = setting.step;
            input.value = settings[setting.id];
            input.style.width = '80px';
        }
        
        settingContainer.appendChild(input);
        popup.appendChild(settingContainer);
    });
    
    const buttonContainer = document.createElement('div');
    Object.assign(buttonContainer.style, { display: 'flex', justifyContent: 'center', marginTop: '2px' });
    
    const saveButton = document.createElement('button');
    saveButton.textContent = '保存设置';
    const saveButtonBgColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBorderColor') || '#4dabf7';
    const saveButtonHoverColor = getComputedStyle(document.body).getPropertyValue('--SmartThemeBlurTintStrength') || '#5db8ff';
    Object.assign(saveButton.style, { 
        padding: '8px 16px', 
        borderRadius: '4px', 
        backgroundColor: saveButtonBgColor.trim(), 
        border: 'none', 
        color: 'white', 
        cursor: 'pointer' 
    });
    
    saveButton.addEventListener('click', () => {
        // 1. 获取并保存所有设置
        const currentSettings = getPluginSettings();
        settingsConfig.forEach(setting => {
            const input = document.getElementById(`st_setting_popup_${setting.id}`);
            if (setting.type === 'checkbox') {
                currentSettings[setting.id] = input.checked;
            } else {
                const v = parseFloat(input.value);
                currentSettings[setting.id] = isNaN(v) ? defaultSettings[setting.id] : v;
            }
        });
        saveSettingsDebounced();
        loadConfig();

        // 2. 更新按钮安装状态
        if (currentSettings.autoInstallButtons) {
            document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
            installScreenshotButtons();
        } else {
            document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
        }

        // 3. 关闭弹窗
        document.body.removeChild(overlay);

        // 4. 弹出 toastr 提示
        if (window.toastr && typeof toastr.success === 'function') {
            toastr.success('设置已成功保存！');
        }

        // 添加隐藏的输入控件以保留功能
        const hiddenInputs = document.createElement('div');
        hiddenInputs.style.display = 'none';
        
        const autoInstallInput = document.createElement('input');
        autoInstallInput.type = 'checkbox';
        autoInstallInput.id = 'st_setting_popup_autoInstallButtons';
        autoInstallInput.checked = currentSettings.autoInstallButtons;
        hiddenInputs.appendChild(autoInstallInput);
        
        const altButtonInput = document.createElement('input');
        altButtonInput.type = 'checkbox';
        altButtonInput.id = 'st_setting_popup_altButtonLocation';
        altButtonInput.checked = currentSettings.altButtonLocation;
        hiddenInputs.appendChild(altButtonInput);
        
        const debugOverlayInput = document.createElement('input');
        debugOverlayInput.type = 'checkbox';
        debugOverlayInput.id = 'st_setting_popup_debugOverlay';
        debugOverlayInput.checked = currentSettings.debugOverlay;
        hiddenInputs.appendChild(debugOverlayInput);
        
        popup.appendChild(hiddenInputs);
    });
    
    buttonContainer.appendChild(saveButton);
    popup.appendChild(buttonContainer);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}
