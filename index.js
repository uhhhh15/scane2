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
const PLUGIN_ID = 'html2canvas-pro';
const PLUGIN_NAME = 'html2canvas-pro';

// 插件的默认设置
const defaultSettings = {
    screenshotDelay: 10,       // 可以设置更低值，比如 0-20
    scrollDelay: 10,
    autoInstallButtons: true,
    altButtonLocation: true,
    screenshotScale: 2.0,      // 降低到 1.0 以提高速度
    useForeignObjectRendering: false,
    letterRendering: true,    // 新增：关闭字形渲染提高文字渲染速度
    imageTimeout: 3000,        // 新增：缩短图像加载超时
    debugOverlay: true         // 新增：是否显示进度遮罩层
};

// 全局配置对象，将从设置中加载
const config = {
    buttonClass: 'st-screenshot-button',
    chatScrollContainerSelector: '#chat', // Used for context, not direct scroll iterations for h2c
    chatContentSelector: '#chat',
    messageSelector: '.mes',
    lastMessageSelector: '.mes.last_mes',
    messageTextSelector: '.mes_block .mes_text',
    messageHeaderSelector: '.mes_block .ch_name',
    // html2canvas options will be loaded from settings
    html2canvasOptions: {
        allowTaint: true,
        useCORS: true,
        backgroundColor: null,
        logging: false,        // 始终关闭日志以提高性能
        removeContainer: true
        // 其他选项会从 settings 加载，不要在这里硬编码
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
    config.scrollDelay = parseInt(settings.scrollDelay, 10) || 0;
    config.autoInstallButtons = settings.autoInstallButtons;
    config.altButtonLocation = settings.altButtonLocation;
    config.debugOverlay = settings.debugOverlay !== undefined ? settings.debugOverlay : true;

    // 将所有html2canvas相关设置正确地应用到 html2canvasOptions
    const loadedScale = parseFloat(settings.screenshotScale);
    if (!isNaN(loadedScale) && loadedScale > 0) {
        config.html2canvasOptions.scale = loadedScale;
    } else {
        config.html2canvasOptions.scale = defaultSettings.screenshotScale;
    }

    // 添加调试输出
    console.log('DEBUG: html2canvas配置加载', config.html2canvasOptions);

    // 应用其他html2canvas设置
    config.html2canvasOptions.foreignObjectRendering = settings.useForeignObjectRendering;
    config.html2canvasOptions.letterRendering = settings.letterRendering !== undefined ?
        settings.letterRendering : defaultSettings.letterRendering;
    config.html2canvasOptions.imageTimeout = settings.imageTimeout || defaultSettings.imageTimeout;

    console.log(`${PLUGIN_NAME}: 配置已加载并应用:`, config);
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

async function getDynamicBackground(elementForContext) {
    const chatContainer = document.querySelector(config.chatContentSelector);
    if (!chatContainer) {
        return { color: '#1e1e1e', imageInfo: null };
    }

    const computedChatStyle = window.getComputedStyle(chatContainer);
    
    let backgroundColor = '#1e1e1e'; // Fallback
    if (computedChatStyle.backgroundColor && computedChatStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && computedChatStyle.backgroundColor !== 'transparent') {
        backgroundColor = computedChatStyle.backgroundColor;
    } else {
        const pcbVar = getComputedStyle(document.body).getPropertyValue('--pcb');
        if (pcbVar && pcbVar.trim()) {
            backgroundColor = pcbVar.trim();
        }
    }
    
    const bgElement = document.querySelector('#bg1, #bg2') || chatContainer;
    const computedBgStyle = window.getComputedStyle(bgElement);
    
    let backgroundImageInfo = null;
    if (computedBgStyle.backgroundImage && computedBgStyle.backgroundImage !== 'none') {
        const bgImageUrlMatch = computedBgStyle.backgroundImage.match(/url\("?(.+?)"?\)/);
        if (bgImageUrlMatch) {
            const bgImageUrl = bgImageUrlMatch[1];
            
            const img = new Image();
            img.src = bgImageUrl;
            await new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
            });

            const elementRect = elementForContext.getBoundingClientRect();
            const bgRect = bgElement.getBoundingClientRect();
            const offsetX = elementRect.left - bgRect.left;
            const offsetY = elementRect.top - bgRect.top;

            backgroundImageInfo = {
                url: bgImageUrl,
                originalWidth: img.naturalWidth || bgRect.width,
                originalHeight: img.naturalHeight || bgRect.height,
                styles: {
                    backgroundImage: computedBgStyle.backgroundImage,
                    backgroundSize: computedBgStyle.backgroundSize,
                    backgroundRepeat: 'repeat-y', 
                    backgroundPosition: `-${offsetX}px -${offsetY}px`,
                }
            };
        }
    }
    
    return { color: backgroundColor, imageInfo: backgroundImageInfo };
}


jQuery(async () => {
    console.log(`${PLUGIN_NAME}: 插件初始化中...`);

    try {
        await loadScript(`scripts/extensions/third-party/${PLUGIN_ID}/html2canvas-pro.min.js`);
    } catch (error) {
        console.error(`${PLUGIN_NAME}: 无法加载 html2canvas-pro.min.js。插件功能将受限。`, error);
        return;
    }

    loadConfig();

    let settingsHtml;
    try {
        settingsHtml = await renderExtensionTemplateAsync(`third-party/${PLUGIN_ID}`, 'settings');
        console.log(`${PLUGIN_NAME}: 成功加载设置面板模板`);
    } catch (error) {
        console.error(`${PLUGIN_NAME}: 无法加载设置面板模板:`, error);
        
        settingsHtml = `
        <div id="scane2_settings">
          <h2>ST截图3.0</h2>

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
              <label for="st_h2c_scrollDelay">UI更新等待 (ms):</label>
              <input type="number" id="st_h2c_scrollDelay" min="0" max="2000" step="50" value="${defaultSettings.scrollDelay}">
            </div>
            <div class="option">
              <label for="st_h2c_screenshotScale">渲染比例 (Scale):</label>
              <input type="number" id="st_h2c_screenshotScale" min="0.5" max="4.0" step="0.1" value="${defaultSettings.screenshotScale}">
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_useForeignObjectRendering" ${defaultSettings.useForeignObjectRendering ? 'checked' : ''}>
              <label for="st_h2c_useForeignObjectRendering">尝试快速模式 (兼容性低)</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_autoInstallButtons" ${defaultSettings.autoInstallButtons ? 'checked' : ''}>
              <label for="st_h2c_autoInstallButtons">自动安装消息按钮</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_altButtonLocation" ${defaultSettings.altButtonLocation ? 'checked' : ''}>
              <label for="st_h2c_altButtonLocation">按钮备用位置</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_letterRendering" ${defaultSettings.letterRendering ? 'checked' : ''}>
              <label for="st_h2c_letterRendering">字形渲染</label>
            </div>
            <div class="option">
              <input type="checkbox" id="st_h2c_debugOverlay" ${defaultSettings.debugOverlay ? 'checked' : ''}>
              <label for="st_h2c_debugOverlay">显示调试覆盖层</label>
            </div>

            <button id="st_h2c_saveSettingsBtn" class="menu_button">保存设置</button>
            <div class="status-area" id="st_h2c_saveStatus" style="display:none;"></div>
          </div>
        </div>
        `;
    }

    $('#extensions_settings_content').append(settingsHtml);

    const settingsForm = $('#extensions_settings_content');

    const screenshotDelayEl = settingsForm.find('#st_h2c_screenshotDelay');
    const scrollDelayEl = settingsForm.find('#st_h2c_scrollDelay');
    const screenshotScaleEl = settingsForm.find('#st_h2c_screenshotScale');
    const useForeignObjectRenderingEl = settingsForm.find('#st_h2c_useForeignObjectRendering');
    const autoInstallButtonsEl = settingsForm.find('#st_h2c_autoInstallButtons');
    const altButtonLocationEl = settingsForm.find('#st_h2c_altButtonLocation');
    const saveSettingsBtn = settingsForm.find('#st_h2c_saveSettingsBtn');
    const saveStatusEl = settingsForm.find('#st_h2c_saveStatus');
    const captureLastMsgBtn = settingsForm.find('#st_h2c_captureLastMsgBtn');
    const letterRenderingEl = settingsForm.find('#st_h2c_letterRendering');
    const debugOverlayEl = settingsForm.find('#st_h2c_debugOverlay');

    function updateSettingsUI() {
        const settings = getPluginSettings();
        screenshotDelayEl.val(settings.screenshotDelay);
        scrollDelayEl.val(settings.scrollDelay);
        screenshotScaleEl.val(settings.screenshotScale);
        useForeignObjectRenderingEl.prop('checked', settings.useForeignObjectRendering);
        autoInstallButtonsEl.prop('checked', settings.autoInstallButtons);
        altButtonLocationEl.prop('checked', settings.altButtonLocation !== undefined ? settings.altButtonLocation : true);
        
        if (letterRenderingEl) letterRenderingEl.prop('checked', settings.letterRendering);
        if (debugOverlayEl) debugOverlayEl.prop('checked', settings.debugOverlay);
    }

    saveSettingsBtn.on('click', () => {
        const settings = getPluginSettings();

        settings.screenshotDelay = parseInt(screenshotDelayEl.val(), 10) || defaultSettings.screenshotDelay;
        settings.scrollDelay = parseInt(scrollDelayEl.val(), 10) || defaultSettings.scrollDelay;
        settings.screenshotScale = parseFloat(screenshotScaleEl.val()) || defaultSettings.screenshotScale;
        settings.useForeignObjectRendering = useForeignObjectRenderingEl.prop('checked');
        settings.autoInstallButtons = autoInstallButtonsEl.prop('checked');
        settings.altButtonLocation = altButtonLocationEl.prop('checked');
        settings.letterRendering = letterRenderingEl.prop('checked');
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
    });

    captureLastMsgBtn.on('click', async () => {
        const options = {
            target: 'last',
            includeHeader: true
        };
        try {
            const dataUrl = await captureMessageWithOptions(options);
            if (dataUrl) {
                downloadImage(dataUrl, null, options.target);
            } else {
                throw new Error('未能生成截图');
            }
        } catch (error) {
            console.error('从设置面板截图失败:', error.stack || error);
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

    function addExtensionMenuButton() {
        if (document.querySelector(`#extensionsMenu .fa-camera[data-plugin-id="${PLUGIN_ID}"]`)) {
            return;
        }
        
        const menuButton = document.createElement('div');
        menuButton.classList.add('fa-solid', 'fa-camera', 'extensionsMenuExtension');
        menuButton.title = PLUGIN_NAME;
        menuButton.setAttribute('data-plugin-id', PLUGIN_ID);

        menuButton.appendChild(document.createTextNode('截图设置'));
        
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

    function showScreenshotPopup() {
        const overlay = document.createElement('div');
        overlay.className = 'st-screenshot-overlay';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
        overlay.style.zIndex = '10000';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';

        const popup = document.createElement('div');
        popup.className = 'st-screenshot-popup';
        popup.style.backgroundColor = '#2a2a2a';
        popup.style.padding = '20px';
        popup.style.borderRadius = '10px';
        popup.style.maxWidth = '300px';
        popup.style.width = '100%';

        const options = [
            { id: 'last_msg', icon: 'fa-camera', text: '截取最后一条消息' },
            { id: 'conversation', icon: 'fa-images', text: '截取整个对话' },
            { id: 'settings', icon: 'fa-gear', text: '调整截图设置' }
        ];
        
        options.forEach(option => {
            const btn = document.createElement('div');
            btn.className = 'st-screenshot-option';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.gap = '10px';
            btn.style.padding = '12px';
            btn.style.margin = '8px 0';
            btn.style.borderRadius = '5px';
            btn.style.cursor = 'pointer';
            
            btn.innerHTML = `
                <i class="fa-solid ${option.icon}" style="font-size: 1.2em;"></i>
                <span>${option.text}</span>
            `;
            
            btn.addEventListener('mouseover', () => btn.style.backgroundColor = '#4a4a4a');
            btn.addEventListener('mouseout', () => btn.style.backgroundColor = '#3a3a3a');
            
            btn.addEventListener('click', async () => {
                console.log(`[${PLUGIN_NAME}] ${option.id} clicked`);
                document.body.removeChild(overlay);
                
                try {
                    switch(option.id) {
                        case 'last_msg':
                            const dataUrl = await captureMessageWithOptions({
                                target: 'last',
                                includeHeader: true
                            });
                            if (dataUrl) downloadImage(dataUrl, null, 'last_message');
                            break;
                        case 'conversation':
                            const convDataUrl = await captureMessageWithOptions({
                                target: 'conversation',
                                includeHeader: true
                            });
                            if (convDataUrl) downloadImage(convDataUrl, null, 'conversation');
                            break;
                        case 'settings':
                            showSettingsPopup();
                            break;
                    }
                } catch (error) {
                    console.error(`[${PLUGIN_NAME}] 操作失败:`, error);
                    alert(`操作失败: ${error.message || '未知错误'}`);
                }
            });
            
            popup.appendChild(btn);
        });
        
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
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
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    waitForExtensionsMenu();
});


// ### FIX 1 of 3: Remove the red debug border which adds 1px margin ###
function prepareSingleElementForHtml2CanvasPro(originalElement) {
    if (!originalElement) return null;

    const element = originalElement.cloneNode(true);
    
    const computedStyle = window.getComputedStyle(originalElement);
    const importantStyles = [
        'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'display', 'position', 'top', 'right', 'bottom', 'left',
        'font-family', 'font-size', 'font-weight', 'line-height',
        'color', 'background-color', 'border', 'border-radius',
        'text-align', 'vertical-align', 'white-space', 'overflow', 'visibility'
    ];
    
    importantStyles.forEach(style => {
        element.style[style] = computedStyle[style];
    });
    
    element.querySelectorAll('.mes_buttons').forEach(buttonsArea => {
        buttonsArea?.parentNode?.removeChild(buttonsArea);
    });
    
    ['mesIDDisplay', 'mes_timer', 'tokenCounterDisplay'].forEach(selector => {
        element.querySelectorAll(`.${selector}`).forEach(el => {
            el?.parentNode?.removeChild(el);
        });
    });

    element.querySelectorAll('script, style, noscript, canvas').forEach(el => el.remove());
    
    element.querySelectorAll('.mes_reasoning, .mes_reasoning_delete, .mes_reasoning_edit_cancel').forEach(el => {
        if (el?.style) {
            el.style.removeProperty('color');
            el.style.removeProperty('background-color');
            el.style.removeProperty('border-color');
        }
    });

    function syncDetailsState(origNode, cloneNode) {
        if (!origNode || !cloneNode) return;
        
        if (origNode.tagName === 'DETAILS') {
            const isOpen = origNode.hasAttribute('open');
            
            if (isOpen) {
                cloneNode.setAttribute('open', '');
            } else {
                cloneNode.removeAttribute('open');
                
                Array.from(cloneNode.childNodes).forEach(child => {
                    if (child.tagName && child.tagName !== 'SUMMARY') {
                        cloneNode.removeChild(child);
                    }
                });
            }
        }
        
        const origChildren = origNode.children || [];
        const cloneChildren = cloneNode.children || [];
        
        if (origChildren.length === cloneChildren.length) {
            for (let i = 0; i < origChildren.length; i++) {
                syncDetailsState(origChildren[i], cloneChildren[i]);
            }
        }
    }
    
    syncDetailsState(originalElement, element);
    
    element.style.display = 'block';
    element.style.visibility = 'visible';
    element.style.opacity = '1';
    element.style.width = originalElement.offsetWidth + 'px';
    element.style.height = 'auto';
    element.style.overflow = 'visible';
    
    // ### FIX: Removed the debug border that adds unwanted pixels to the screenshot.
    // element.style.border = '1px solid red';
    
    return element;
}

async function handleIframesAsync(clonedElement, originalDocument) {
    const iframes = clonedElement.querySelectorAll('iframe');
    if (iframes.length === 0) {
        return;
    }

    const originalIframes = Array.from(originalDocument.querySelectorAll('iframe'));

    const promises = Array.from(iframes).map(async (iframe, index) => {
        const originalIframe = originalIframes[index];
        if (!originalIframe) return;

        try {
            const isSameOrigin = originalIframe.contentWindow && originalIframe.contentWindow.document;

            if (isSameOrigin) {
                console.log(`${PLUGIN_NAME}: Same-origin iframe found, recursively capturing...`, originalIframe.src);
                const iframeDoc = originalIframe.contentWindow.document;
                
                const canvas = await html2canvas(iframeDoc.body, {
                    scale: config.html2canvasOptions.scale,
                    useCORS: true,
                    allowTaint: true,
                    backgroundColor: window.getComputedStyle(iframeDoc.body).backgroundColor,
                    foreignObjectRendering: false, 
                });
                
                const imgDataUrl = canvas.toDataURL('image/png');
                
                const img = document.createElement('img');
                img.src = imgDataUrl;
                img.style.width = iframe.style.width || `${originalIframe.clientWidth}px`;
                img.style.height = iframe.style.height || `${originalIframe.clientHeight}px`;
                img.style.border = 'none';

                if (iframe.parentNode) {
                    iframe.parentNode.replaceChild(img, iframe);
                }
            } else {
                console.warn(`${PLUGIN_NAME}: Cross-origin iframe found, cannot capture. Creating placeholder.`, originalIframe.src);
                const placeholder = document.createElement('div');
                placeholder.style.width = iframe.style.width || `${originalIframe.clientWidth}px`;
                placeholder.style.height = iframe.style.height || `${originalIframe.clientHeight}px`;
                placeholder.style.border = '1px dashed #999';
                placeholder.style.backgroundColor = '#f0f0f0';
                placeholder.style.display = 'flex';
                placeholder.style.alignItems = 'center';
                placeholder.style.justifyContent = 'center';
                placeholder.style.fontSize = '12px';
                placeholder.style.color = '#666';
                placeholder.textContent = '跨源内容无法截取';
                if (iframe.parentNode) {
                    iframe.parentNode.replaceChild(placeholder, iframe);
                }
            }
        } catch (error) {
            console.error(`${PLUGIN_NAME}: Error processing iframe:`, error, originalIframe.src);
             const errorPlaceholder = document.createElement('div');
             errorPlaceholder.style.width = iframe.style.width || `${originalIframe.clientWidth}px`;
             errorPlaceholder.style.height = iframe.style.height || `${originalIframe.clientHeight}px`;
             errorPlaceholder.style.border = '1px dashed red';
             errorPlaceholder.textContent = 'Iframe 渲染错误';
             if (iframe.parentNode) {
                 iframe.parentNode.replaceChild(errorPlaceholder, iframe);
             }
        }
    });

    await Promise.all(promises);
}

// ### FIX 2 of 3: Removed container padding and negative offset to perfectly frame the content ###
async function captureElementWithHtml2Canvas(elementToCapture, h2cUserOptions = {}) {
    console.log('启动最终截图流程:', elementToCapture);
    
    let overlay = null;
    if (config.debugOverlay) {
        overlay = createOverlay('启动截图流程...');
        document.body.appendChild(overlay);
    }
    
    let finalDataUrl = null;
    const tempContainer = document.createElement('div');

    try {
        if (overlay) updateOverlay(overlay, '准备内容和计算尺寸...', 0.05);
        const contentWidth = elementToCapture.offsetWidth;
        if (contentWidth === 0) {
            throw new Error("无法测量消息内容宽度，元素可能不可见。");
        }

        const preparedElement = prepareSingleElementForHtml2CanvasPro(elementToCapture);
        if (!preparedElement) throw new Error("无法准备截图元素");

        // ### FIX: Removed the unnecessary negative offset hack.
        /*
        Object.assign(preparedElement.style, {
            position: 'relative',
            left: '-10px',
            top: '-10px',
        });
        */

        if (overlay) updateOverlay(overlay, '获取并构建背景...', 0.15);
        const background = await getDynamicBackground(elementToCapture);

        Object.assign(tempContainer.style, {
            position: 'absolute',
            left: '-9999px',
            top: '0px',
            width: `${contentWidth}px`,
            // ### FIX: Removed padding to eliminate unwanted margins.
            padding: '0', 
            backgroundColor: background.color,
            overflow: 'visible',
        });

        if (background.imageInfo) {
            Object.assign(tempContainer.style, background.imageInfo.styles);
        }

        tempContainer.appendChild(preparedElement);
        document.body.appendChild(tempContainer);

        if (overlay) updateOverlay(overlay, '正在处理内联框架(iframe)...', 0.25);
        await handleIframesAsync(tempContainer, elementToCapture.ownerDocument);
        
        await new Promise(resolve => setTimeout(resolve, Math.max(100, config.screenshotDelay)));

        if (overlay) updateOverlay(overlay, '正在渲染场景...', 0.4);

        const finalCanvas = await html2canvas(tempContainer, {
            ...config.html2canvasOptions,
            backgroundColor: null,
            ignoreElements: (element) => {
                const classList = element.classList;
                if (!classList) return false;
                if (classList.contains('swipeRightBlock') || 
                    classList.contains('swipe_left') ||
                    classList.contains('st-capture-overlay') ||
                    element.id === 'top-settings-holder' ||
                    element.id === 'form_sheld') {
                    return true;
                }
                return false;
            },
        });
        
        if (overlay) updateOverlay(overlay, '生成最终图像...', 0.9);
        finalDataUrl = finalCanvas.toDataURL('image/png');

    } catch (error) {
        console.error('截图流程失败:', error.stack || error);
        if (overlay) updateOverlay(overlay, `渲染错误: ${error.message.substring(0, 60)}...`, 0);
        throw error;
    } finally {
        if (tempContainer.parentElement) {
            tempContainer.parentElement.removeChild(tempContainer);
        }
        if (overlay?.parentElement) {
            const delay = finalDataUrl ? 1200 : 3000;
            const message = finalDataUrl ? '截图完成!' : '截图失败!';
            updateOverlay(overlay, message, finalDataUrl ? 1 : 0);
            setTimeout(() => { if (overlay.parentElement) overlay.parentElement.removeChild(overlay) }, delay);
        }
    }
    
    if (!finalDataUrl) {
        throw new Error("截图流程未能生成最终图像数据。");
    }
    return finalDataUrl;
}

function syncDetailsState(origNode, cloneNode) {
    if (origNode.tagName === 'DETAILS') {
        cloneNode.open = origNode.open;
    }
    
    const origChildren = origNode.children;
    const cloneChildren = cloneNode.children;
    
    if (origChildren.length === cloneChildren.length) {
        for (let i = 0; i < origChildren.length; i++) {
            syncDetailsState(origChildren[i], cloneChildren[i]);
        }
    }
}


// ### FIX 3 of 3: Removed container padding for multi-message captures as well. ###
async function captureMultipleMessagesWithHtml2Canvas(messagesToCapture, actionHint, h2cUserOptions = {}) {
    if (!messagesToCapture || messagesToCapture.length === 0) {
        throw new Error("没有提供消息给 captureMultipleMessagesWithHtml2Canvas");
    }
    console.log(`[captureMultipleMessagesWithHtml2Canvas-pro] Capturing ${messagesToCapture.length} messages. Hint: ${actionHint}`);

    const overlay = createOverlay(`组合 ${messagesToCapture.length} 条消息...`);
    document.body.appendChild(overlay);

    let dataUrl = null;
    const tempContainer = document.createElement('div');

    try {
        tempContainer.style.position = 'absolute';
        tempContainer.style.left = '-9999px';
        tempContainer.style.top = '-9999px';
        // ### FIX: Removed padding to eliminate unwanted margins.
        tempContainer.style.padding = '0';
        tempContainer.style.overflow = 'visible';

        const firstMessage = messagesToCapture[0];
        const containerWidth = firstMessage.offsetWidth + 'px';
        tempContainer.style.width = containerWidth;
        
        updateOverlay(overlay, `正在准备背景...`, 0.02);
        const background = await getDynamicBackground(firstMessage);
        tempContainer.style.backgroundColor = background.color;
        if (background.imageInfo) {
            Object.assign(tempContainer.style, background.imageInfo.styles);
        }

        updateOverlay(overlay, `准备 ${messagesToCapture.length} 条消息...`, 0.05);
        messagesToCapture.forEach(msg => {
            try {
                const preparedClone = prepareSingleElementForHtml2CanvasPro(msg);
                if (preparedClone) {
                    tempContainer.appendChild(preparedClone);
                } else {
                     console.warn("Skipping null prepared clone for message:", msg);
                }
            } catch (e) {
                console.error("Error preparing message for multi-capture:", msg, e);
            }
        });
        document.body.appendChild(tempContainer);
        
        if (overlay) updateOverlay(overlay, '正在处理所有内联框架(iframe)...', 0.15);
        await handleIframesAsync(tempContainer, firstMessage.ownerDocument);
        
        await new Promise(resolve => setTimeout(resolve, config.screenshotDelay));

        updateOverlay(overlay, '正在渲染…', 0.3);

        const finalH2cOptions = {...config.html2canvasOptions, ...h2cUserOptions};
        
        finalH2cOptions.ignoreElements = (element) => {
            const classList = element.classList;
            if (!classList) return false;
            
            if (classList.contains('swipeRightBlock') || 
                classList.contains('swipe_left') ||
                classList.contains('st-capture-overlay') ||
                element.id === 'top-settings-holder' ||
                element.id === 'form_sheld') {
                return true;
            }
            
            return false;
        };

        console.log("DEBUG: html2canvas-pro (multiple) options:", finalH2cOptions);
        const canvas = await html2canvas(tempContainer, finalH2cOptions);

        updateOverlay(overlay, '生成图像数据...', 0.8);
        dataUrl = canvas.toDataURL('image/png');

    } catch (error) {
        console.error('html2canvas-pro 多消息截图失败:', error.stack || error);
         if (overlay && document.body.contains(overlay)) {
             const errorMsg = error && error.message ? error.message : "未知渲染错误";
             updateOverlay(overlay, `多消息渲染错误: ${errorMsg.substring(0,50)}...`, 0);
        }
        throw error;
    } finally {
        if (tempContainer?.parentElement) {
            document.body.removeChild(tempContainer);
        }
        if (overlay?.parentElement) {
            updateOverlay(overlay, dataUrl ? '截图完成!' : '截图失败!', dataUrl ? 1 : 0);
            setTimeout(() => { if (overlay.parentElement) document.body.removeChild(overlay); }, 1500);
        }
    }
    if (!dataUrl) throw new Error("html2canvas-pro 未能生成多消息图像数据。");
    console.log("DEBUG: html2canvas-pro multiple messages capture successful.");
    return dataUrl;
}

async function captureMessageWithOptions(options) {
    const { target, includeHeader } = options;
    console.log('captureMessageWithOptions (html2canvas-pro v5) called with:', options);

    const chatSelector = config.chatContentSelector;
    if (typeof chatSelector !== 'string' || !chatSelector) {
         const errorMsg = `聊天内容容器选择器无效: '${chatSelector}'`;
         console.error(`${PLUGIN_NAME}:`, errorMsg);
         throw new Error(errorMsg);
    }
    const chatContentEl = document.querySelector(chatSelector);
    if (!chatContentEl) {
         const errorMsg = `聊天内容容器 '${chatSelector}' 未找到!`;
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
            return await captureMultipleMessagesWithHtml2Canvas(messagesForMultiCapture, "conversation_all", {});
        default:
            throw new Error('未知的截图目标类型');
    }

    if (!elementToRender && messagesForMultiCapture.length === 0) {
         throw new Error(`目标元素未找到 (for ${target} within ${chatSelector})`);
    }

    if (elementToRender) {
        let finalElementToCapture = elementToRender;
        if (!includeHeader && target !== 'conversation' && elementToRender.querySelector(config.messageTextSelector)) {
            const textElement = elementToRender.querySelector(config.messageTextSelector);
            if (textElement) {
                finalElementToCapture = textElement;
                console.log('Capturing text element only with html2canvas-pro v5:', finalElementToCapture);
            } else {
                console.warn("Could not find text element for includeHeader: false, capturing full message.");
            }
        }
        return await captureElementWithHtml2Canvas(finalElementToCapture, {});
    }
    throw new Error("captureMessageWithOptions (h2c-pro v5): Unhandled capture scenario.");
}

function installScreenshotButtons() {
    document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());

    const chatSelector = config.chatContentSelector;
    if (typeof chatSelector !== 'string' || !chatSelector) {
         console.error(`${PLUGIN_NAME}: 无法安装按钮，聊天内容容器选择器无效:`, chatSelector);
         return false;
    }
    const chatContentEl = document.querySelector(chatSelector);
    if (chatContentEl) {
        chatContentEl.querySelectorAll(config.messageSelector).forEach(message => addScreenshotButtonToMessage(message));
    } else {
        console.warn(`Chat content ('${chatSelector}') not found for initial button installation.`);
    }


    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.matches(config.messageSelector)) {
                addScreenshotButtonToMessage(node);
              }
              else if (node.querySelectorAll) {
                node.querySelectorAll(config.messageSelector).forEach(addScreenshotButtonToMessage);
              }
            }
          });
        }
      });
    });

    if (chatContentEl) {
      observer.observe(chatContentEl, { childList: true, subtree: true });
    } else {
      console.warn(`Chat content ('${chatSelector}') not found for MutationObserver.`);
    }
    console.log(`${PLUGIN_NAME}: 截图按钮安装逻辑已执行。`);
    return true;
}

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
    Object.assign(contextMenu.style, { display: 'none', position: 'absolute', zIndex: '10000', background: '#2a2a2a', border: '1px solid #555', borderRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.3)', padding: '5px 0' });

    const menuOptions = [
      { text: '截取前四条消息', action: 'prev4' },
      { text: '截取前三条消息', action: 'prev3' },
      { text: '截取前两条消息', action: 'prev2' },
      { text: '截取前一条消息', action: 'prev1' },
      { text: '截取后一条消息', action: 'next1' },
      { text: '截取后两条消息', action: 'next2' },
      { text: '截取后三条消息', action: 'next3' },
      { text: '截取后四条消息', action: 'next4' }
    ];

    menuOptions.forEach(option => {
      const menuItem = document.createElement('div');
      menuItem.className = 'st-screenshot-menu-item';
      menuItem.textContent = option.text;
      Object.assign(menuItem.style, { padding: '8px 12px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background-color 0.2s' });
      menuItem.onmouseover = () => menuItem.style.backgroundColor = '#3a3a3a';
      menuItem.onmouseout = () => menuItem.style.backgroundColor = 'transparent';

      menuItem.onclick = async (e) => {
        e.stopPropagation();
        hideContextMenu();
        await captureMultipleMessagesFromContextMenu(messageElement, option.action);
      };
      contextMenu.appendChild(menuItem);
    });
    document.body.appendChild(contextMenu);

    let pressTimer;
    let isLongPress = false;

    function showContextMenu(x, y) {
      contextMenu.style.display = 'block';
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const menuW = contextMenu.offsetWidth;
      const menuH = contextMenu.offsetHeight;

      if (x + menuW > vpW) x = vpW - menuW - 5;
      if (y + menuH > vpH) y = vpH - menuH - 5;
      if (y < 0) y = 5;


      contextMenu.style.left = `${x}px`;
      contextMenu.style.top = `${y}px`;
       console.log(`DEBUG: Showing context menu at ${x}, ${y}`);
    }

    function hideContextMenu() {
      contextMenu.style.display = 'none';
       console.log('DEBUG: Hiding context menu');
    }

    screenshotButton.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        const rect = screenshotButton.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 5);
      }, 500);
    });

    screenshotButton.addEventListener('mouseup', () => clearTimeout(pressTimer));
    screenshotButton.addEventListener('mouseleave', () => clearTimeout(pressTimer));

    document.addEventListener('click', (e) => {
      if (contextMenu.style.display === 'block' && !contextMenu.contains(e.target) && !screenshotButton.contains(e.target)) {
          hideContextMenu();
      }
    });

    screenshotButton.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    screenshotButton.addEventListener('touchstart', (e) => {
      isLongPress = false;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        const rect = screenshotButton.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 5);
      }, 500);
    });

    screenshotButton.addEventListener('touchend', () => clearTimeout(pressTimer));
    screenshotButton.addEventListener('touchcancel', () => clearTimeout(pressTimer));

    screenshotButton.addEventListener('click', async function(event) {
      event.preventDefault();
      event.stopPropagation();

      if (isLongPress) {
        isLongPress = false;
        return;
      }

      if (this.classList.contains('loading')) return;

      const iconElement = this.querySelector('i');
      const originalIconClass = iconElement ? iconElement.className : '';
      if (iconElement) iconElement.className = `fa-solid fa-spinner fa-spin ${config.buttonClass}-icon-loading`;
      this.classList.add('loading');

      try {
        const dataUrl = await captureElementWithHtml2Canvas(messageElement, {});
        downloadImage(dataUrl, messageElement, 'message');
      } catch (error) {
        console.error('消息截图失败 (h2c-pro button click v5):', error.stack || error);
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

async function captureMultipleMessagesFromContextMenu(currentMessageElement, action) {
    console.log(`[多消息截图 ctx menu h2c-pro v5] Action: ${action} from msg:`, currentMessageElement);
    const button = currentMessageElement.querySelector(`.${config.buttonClass}`);
    const iconElement = button ? button.querySelector('i') : null;
    const originalIconClass = iconElement ? iconElement.className : '';

    if (button) button.classList.add('loading');
    if (iconElement) iconElement.className = `fa-solid fa-spinner fa-spin ${config.buttonClass}-icon-loading`;

    try {
        const chatSelector = config.chatContentSelector;
        if (typeof chatSelector !== 'string' || !chatSelector) {
             const errorMsg = `无法进行多消息截图，聊天内容容器选择器无效: '${chatSelector}'`;
             console.error(`${PLUGIN_NAME}:`, errorMsg);
             throw new Error(errorMsg);
        }
        const chatContent = document.querySelector(chatSelector);
        if (!chatContent) {
             const errorMsg = `无法进行多消息截图，聊天内容容器 '${chatSelector}' 未找到!`;
             console.error(`${PLUGIN_NAME}:`, errorMsg);
             throw new Error(errorMsg);
        }


        let allMessages = Array.from(chatContent.querySelectorAll(config.messageSelector));
        let currentIndex = allMessages.indexOf(currentMessageElement);
        if (currentIndex === -1) throw new Error('无法确定当前消息位置');

        let startIndex = currentIndex;
        let endIndex = currentIndex;
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

        const dataUrl = await captureMultipleMessagesWithHtml2Canvas(targetMessages, action, {});

        if (dataUrl) {
            const actionTextMap = {
                'prev4':'前四条',
                'prev3':'前三条',
                'prev2':'前两条',
                'prev1':'前一条',
                'next1':'后一条',
                'next2':'后两条',
                'next3':'后三条',
                'next4':'后四条'
            };
            const fileNameHint = `ST消息组_${actionTextMap[action] || action}`;
            downloadImage(dataUrl, currentMessageElement, fileNameHint);
            console.log(`[多消息截图 ctx menu h2c-pro v5] 截图成功 for ${action}`);
        } else {
            throw new Error('多消息截图 html2canvas-pro 生成失败');
        }
    } catch (error) {
        console.error(`[多消息截图 ctx menu h2c-pro v5] 失败 (${action}):`, error.stack || error);
        alert(`截图 (${action}) 失败: ${error.message || '未知错误'}`);
    } finally {
        if (iconElement) iconElement.className = originalIconClass;
        if (button) button.classList.remove('loading');
        console.log(`[多消息截图 ctx menu h2c-pro v5] 完成 (${action})`);
    }
}

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

function updateOverlay(overlay, message, progressRatio) {
    if (!overlay || !overlay.parentNode) return;
    const messageP = overlay.querySelector('.st-capture-status p');
    const progressBar = overlay.querySelector('.st-progress-bar');
    if (messageP) messageP.textContent = message;
    const safeProgress = Math.max(0, Math.min(1, progressRatio));
    if (progressBar) progressBar.style.width = `${Math.round(safeProgress * 100)}%`;
}

function showSettingsPopup() {
    const settings = getPluginSettings();
    
    const overlay = document.createElement('div');
    overlay.className = 'st-settings-overlay';
    Object.assign(overlay.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0,0,0,0.7)',
        zIndex: '10000',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start'
    });

    const popup = document.createElement('div');
    popup.className = 'st-settings-popup';
    Object.assign(popup.style, {
        backgroundColor: '#2a2a2a',
        padding: '20px',
        borderRadius: '10px',
        maxWidth: '400px',
        width: '100%',
        maxHeight: '80vh',
        overflowY: 'auto',
        marginTop: '25vh'
    });

    
    const title = document.createElement('h3');
    title.textContent = '截图设置';
    title.style.marginTop = '0';
    title.style.marginBottom = '15px';
    title.style.textAlign = 'center';
    popup.appendChild(title);
    
    const settingsConfig = [
        { id: 'screenshotDelay', type: 'number', label: '截图前延迟 (ms)', min: 0, max: 2000, step: 50 },
        { id: 'scrollDelay', type: 'number', label: 'UI更新等待 (ms)', min: 0, max: 2000, step: 50 },
        { id: 'screenshotScale', type: 'number', label: '渲染比例 (Scale)', min: 0.5, max: 4.0, step: 0.1 },
        { id: 'useForeignObjectRendering', type: 'checkbox', label: '尝试快速模式 (兼容性低)' },
        { id: 'autoInstallButtons', type: 'checkbox', label: '自动安装消息按钮' },
        { id: 'altButtonLocation', type: 'checkbox', label: '按钮备用位置' },
        { id: 'letterRendering', type: 'checkbox', label: '字形渲染' },
        { id: 'debugOverlay', type: 'checkbox', label: '显示调试覆盖层' }
    ];
    
    settingsConfig.forEach(setting => {
        const settingContainer = document.createElement('div');
        settingContainer.style.margin = '10px 0';
        settingContainer.style.display = 'flex';
        settingContainer.style.justifyContent = 'space-between';
        settingContainer.style.alignItems = 'center';
        
        const label = document.createElement('label');
        label.textContent = setting.label;
        label.style.marginRight = '10px';
        settingContainer.appendChild(label);
        
        let input;
        if (setting.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `st_setting_${setting.id}`;
            input.checked = settings[setting.id];
        } else if (setting.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.id = `st_setting_${setting.id}`;
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
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'center';
    buttonContainer.style.marginTop = '20px';
    
    const saveButton = document.createElement('button');
    saveButton.textContent = '保存设置';
    saveButton.style.padding = '8px 16px';
    saveButton.style.borderRadius = '4px';
    saveButton.style.backgroundColor = '#4dabf7';
    saveButton.style.border = 'none';
    saveButton.style.color = 'white';
    saveButton.style.cursor = 'pointer';
    
    saveButton.addEventListener('click', () => {
        const settings = getPluginSettings();
        
        settingsConfig.forEach(setting => {
            const input = document.getElementById(`st_setting_${setting.id}`);
            if (setting.type === 'checkbox') {
                settings[setting.id] = input.checked;
            } else if (setting.type === 'number') {
                settings[setting.id] = parseFloat(input.value);
                if (isNaN(settings[setting.id])) {
                    settings[setting.id] = defaultSettings[setting.id];
                }
            }
        });
        
        saveSettingsDebounced();
        loadConfig();
        
        const statusMsg = document.createElement('div');
        statusMsg.textContent = '设置已保存！';
        statusMsg.style.color = '#4cb944';
        statusMsg.style.textAlign = 'center';
        statusMsg.style.marginTop = '10px';
        buttonContainer.appendChild(statusMsg);
        
        setTimeout(() => {
            if (overlay.parentElement) {
                document.body.removeChild(overlay);
            }
            
            if (settings.autoInstallButtons) {
                document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
                installScreenshotButtons();
            } else {
                document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
            }
        }, 1500);
    });
    
    buttonContainer.appendChild(saveButton);
    popup.appendChild(buttonContainer);
    
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) document.body.removeChild(overlay);
    });
}
