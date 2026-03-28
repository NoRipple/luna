/* 主要职责：负责桌宠覆盖层渲染逻辑，包括 Live2D 展示、语音播放和前端交互。 */
function logError(msg) {
            console.error(msg);
            const el = document.getElementById('error-log');
            el.style.display = 'block';
            el.innerHTML += msg + '<br>';
        }

        const live2dRuntime = {
            availableMotions: new Set(),
            fallbackMotionName: 'idle'
        };

        function getSafeMotionName(requestedMotion) {
            const requested = String(requestedMotion || '').trim();
            if (!requested) return live2dRuntime.fallbackMotionName;
            if (!live2dRuntime.availableMotions.size) return requested;
            return live2dRuntime.availableMotions.has(requested)
                ? requested
                : live2dRuntime.fallbackMotionName;
        }

        function playSafeMotion(model, requestedMotion) {
            const safeMotionName = getSafeMotionName(requestedMotion);
            if (!safeMotionName) return;
            model.motion(safeMotionName);
        }

        function disableLive2DMotionAudio(model) {
            try {
                const soundManager = window.PIXI?.live2d?.SoundManager;
                if (soundManager) {
                    soundManager.volume = 0;
                    if (typeof soundManager.destroy === 'function') {
                        soundManager.destroy();
                    }
                }

                const motionManager = model?.internalModel?.motionManager;
                if (motionManager && typeof motionManager.getSoundFile === 'function') {
                    motionManager.getSoundFile = () => undefined;
                }

                const definitions = motionManager?.definitions;
                if (definitions && typeof definitions === 'object') {
                    for (const groupName of Object.keys(definitions)) {
                        const groupMotions = definitions[groupName];
                        if (!Array.isArray(groupMotions)) continue;
                        for (const motionDef of groupMotions) {
                            if (motionDef && Object.prototype.hasOwnProperty.call(motionDef, 'Sound')) {
                                delete motionDef.Sound;
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn('Failed to disable Live2D motion audio:', error);
            }
        }

        function rectanglesIntersect(a, b) {
            if (!a || !b) return false;
            return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        }

        function positionBubbleNearModel(model) {
            const bubble = document.getElementById('chat-bubble');
            if (!bubble || !model) return;

            const bounds = model.getBounds();
            const bubbleWidth = Math.min(bubble.offsetWidth || 280, window.innerWidth - 24);
            const bubbleHeight = bubble.offsetHeight || 76;
            const viewportPadding = 12;
            const maxLeft = window.innerWidth - bubbleWidth - viewportPadding;
            const maxTop = window.innerHeight - bubbleHeight - 18;
            const modelRect = {
                left: bounds.x,
                top: bounds.y,
                right: bounds.x + bounds.width,
                bottom: bounds.y + bounds.height
            };

            const candidates = [
                { left: bounds.x - bubbleWidth - 18, top: bounds.y + 18 },
                { left: bounds.x + bounds.width + 16, top: bounds.y + 18 },
                { left: bounds.x + bounds.width * 0.5 - bubbleWidth / 2, top: bounds.y - bubbleHeight - 18 },
                { left: bounds.x + bounds.width * 0.5 - bubbleWidth / 2, top: bounds.y + bounds.height + 14 }
            ].map((item) => ({
                left: Math.max(viewportPadding, Math.min(item.left, maxLeft)),
                top: Math.max(viewportPadding, Math.min(item.top, maxTop))
            }));

            const blockedRects = [];
            const toggle = document.getElementById('chat-toggle');
            if (toggle && toggle.dataset.open === 'false') {
                blockedRects.push(toggle.getBoundingClientRect());
            }

            let selected = candidates[0];
            let foundNonOverlap = false;
            for (const candidate of candidates) {
                const candidateRect = {
                    left: candidate.left,
                    top: candidate.top,
                    right: candidate.left + bubbleWidth,
                    bottom: candidate.top + bubbleHeight
                };
                const overlapsModel = rectanglesIntersect(candidateRect, modelRect);
                const overlapsBlocked = blockedRects.some((blocked) =>
                    rectanglesIntersect(candidateRect, blocked)
                );
                if (!overlapsBlocked && !overlapsModel) {
                    selected = candidate;
                    foundNonOverlap = true;
                    break;
                }
            }

            if (!foundNonOverlap) {
                const preferRight = modelRect.left + (modelRect.right - modelRect.left) / 2 < window.innerWidth / 2;
                selected = {
                    left: preferRight ? maxLeft : viewportPadding,
                    top: viewportPadding
                };
            }

            bubble.style.left = `${selected.left}px`;
            bubble.style.top = `${selected.top}px`;
        }

        function positionChatToggleNearModel(model) {
            const toggle = document.getElementById('chat-toggle');
            if (!toggle || !model) return;

            const bounds = model.getBounds();
            const viewportPadding = 12;
            const toggleSize = Math.max(toggle.offsetWidth || 64, toggle.offsetHeight || 64);
            const preferredLeft = bounds.x + bounds.width - toggleSize * 0.45;
            const preferredTop = bounds.y + Math.max(10, bounds.height * 0.14);
            const maxLeft = window.innerWidth - toggleSize - viewportPadding;
            const maxTop = window.innerHeight - toggleSize - viewportPadding;
            const clampedLeft = Math.max(viewportPadding, Math.min(preferredLeft, maxLeft));
            const clampedTop = Math.max(viewportPadding, Math.min(preferredTop, maxTop));

            toggle.style.left = `${clampedLeft}px`;
            toggle.style.top = `${clampedTop}px`;
            toggle.style.right = 'auto';
            toggle.style.bottom = 'auto';
        }

        window.onload = async () => {
            try {
                if (!window.Live2DCubismCore) {
                    logError('Live2DCubismCore not loaded!');
                }
                if (!window.PIXI) {
                    logError('PIXI not loaded!');
                }
                
                // Expose PIXI to window if not already (Pixi v6 usually does)
                window.PIXI = window.PIXI || PIXI;

                // Check if pixi-live2d-display loaded
                if (!PIXI.live2d) {
                    logError('PIXI.live2d not found. Library might not be loaded.');
                    return;
                }
                
                console.log('PIXI.live2d keys:', Object.keys(PIXI.live2d));
                if (window.Live2DModel) console.log('window.Live2DModel exists');

                const Live2DModel = PIXI.live2d.Live2DModel || window.Live2DModel;
                if (!Live2DModel) {
                    logError('Live2DModel class not found in PIXI.live2d or window!');
                    logError('PIXI.live2d keys: ' + Object.keys(PIXI.live2d).join(', '));
                    return;
                }

                console.log('Libraries loaded successfully.');

                const app = new PIXI.Application({
                    view: document.getElementById('canvas'),
                    autoStart: true,
                    resizeTo: window,
                    transparent: true,
                    backgroundAlpha: 0
                });

                let model = null;
                let isModelScaled = false;
                let baseModelScale = 1;

                window.isModelHovered = false;
                window.isMouseDown = false;
                window.isDragging = false;
                window.isPanelOpen = false;
                window.isUiHovered = false;
                let lastIgnoreMouseEvents = null;

                const syncMouseIgnoreState = () => {
                    if (!window.electronAPI?.setIgnoreMouseEvents) return;
                    const shouldIgnore = !(
                        window.isPanelOpen || window.isUiHovered || window.isDragging || window.isMouseDown || window.isModelHovered
                    );
                    if (lastIgnoreMouseEvents === shouldIgnore) return;
                    if (shouldIgnore) {
                        window.electronAPI.setIgnoreMouseEvents(true, { forward: true });
                    } else {
                        window.electronAPI.setIgnoreMouseEvents(false);
                    }
                    lastIgnoreMouseEvents = shouldIgnore;
                };

                const getCurrentModel = () => model;
                const setPanelOpen = (open) => {
                    window.isPanelOpen = !!open;
                    const toggleButton = document.getElementById('chat-toggle');
                    if (toggleButton) {
                        toggleButton.dataset.open = window.isPanelOpen ? 'true' : 'false';
                        toggleButton.setAttribute('aria-expanded', window.isPanelOpen ? 'true' : 'false');
                    }
                };

                const resizeModel = () => {
                    const currentModel = getCurrentModel();
                    if (!currentModel) return;

                    if (!isModelScaled) {
                        const scaleX = (innerWidth * 0.8) / currentModel.width;
                        const scaleY = (innerHeight * 1.5) / currentModel.height;
                        baseModelScale = Math.max(scaleX, scaleY) * 0.8;
                        isModelScaled = true;
                    }

                    currentModel.scale.set(baseModelScale);
                    currentModel.x = (innerWidth - currentModel.width) / 2;
                    currentModel.y = innerHeight * 0.1;
                    positionChatToggleNearModel(currentModel);
                };

                const bindModelHoverEvents = (targetModel) => {
                    targetModel.interactive = true;
                    targetModel.on('pointerover', () => {
                        window.isModelHovered = true;
                        syncMouseIgnoreState();
                    });
                    targetModel.on('pointerout', () => {
                        window.isModelHovered = false;
                        syncMouseIgnoreState();
                    });
                };

                const destroyModelIfNeeded = (targetModel) => {
                    if (!targetModel) return;
                    try {
                        if (targetModel.parent) {
                            targetModel.parent.removeChild(targetModel);
                        }
                        targetModel.destroy({ children: true, texture: false, baseTexture: false });
                    } catch (error) {
                        console.warn('Failed to destroy previous model:', error);
                    }
                };

                const applyLive2DConfig = (live2dConfig) => {
                    live2dRuntime.availableMotions = new Set(live2dConfig?.motions || []);
                    live2dRuntime.fallbackMotionName = live2dConfig?.fallbackMotion || 'idle';
                };
                let modelMountVersion = 0;

                const mountModelByConfig = async (live2dConfig) => {
                    const mountVersion = ++modelMountVersion;
                    applyLive2DConfig(live2dConfig);
                    const modelPath =
                        live2dConfig?.rendererModelPath ||
                        '../../assets/Azue Lane(JP)/beierfasite_2/beierfasite_2.model3.json';

                    console.log('Loading model from:', modelPath);
                    const nextModel = await Live2DModel.from(modelPath);
                    if (mountVersion !== modelMountVersion) {
                        destroyModelIfNeeded(nextModel);
                        return;
                    }
                    disableLive2DMotionAudio(nextModel);
                    bindModelHoverEvents(nextModel);

                    const previousModel = model;
                    model = nextModel;
                    app.stage.addChild(nextModel);
                    isModelScaled = false;
                    resizeModel();
                    positionBubbleNearModel(nextModel);

                    removeWatermark(nextModel);
                    destroyModelIfNeeded(previousModel);
                    window.isModelHovered = false;
                    syncMouseIgnoreState();

                    console.log('Model loaded!');
                    if (nextModel.internalModel && nextModel.internalModel.motionManager) {
                        console.log('Motion Definitions:', nextModel.internalModel.motionManager.definitions);
                        console.log('Motion Groups:', nextModel.internalModel.motionManager.motionGroups);
                        setTimeout(() => {
                            const currentModel = getCurrentModel();
                            if (!currentModel || currentModel !== nextModel || mountVersion !== modelMountVersion) return;
                            try {
                                playSafeMotion(currentModel, live2dRuntime.fallbackMotionName);
                            } catch (error) {
                                console.error('Failed to start fallback motion:', error);
                            }
                        }, 1000);
                    }
                };

                const reloadLive2DModel = async () => {
                    let live2dConfig = null;
                    if (window.electronAPI && window.electronAPI.getLive2DConfig) {
                        try {
                            live2dConfig = await window.electronAPI.getLive2DConfig();
                        } catch (error) {
                            console.warn('Failed to load live2d config from main process:', error.message);
                        }
                    }
                    await mountModelByConfig(live2dConfig);
                    return live2dConfig;
                };

                window.addEventListener('resize', () => {
                    resizeModel();
                    positionBubbleNearModel(getCurrentModel());
                });

                window.electronAPI.setIgnoreMouseEvents(true, { forward: true });

                document.addEventListener('drag-end', () => {
                    syncMouseIgnoreState();
                });

                window.electronAPI.onCompanionMessage((msg) => {
                    console.log('Received companion message:', msg);
                    const currentModel = getCurrentModel();
                    if (!currentModel) return;

                    if (msg.text) {
                        resetMediaSource();
                    }

                    if (msg.text) {
                        const bubble = document.getElementById('chat-bubble');
                        bubble.textContent = msg.text;
                        bubble.style.display = 'block';
                        positionBubbleNearModel(currentModel);
                    }

                    if (msg.motion) {
                        try {
                            playSafeMotion(currentModel, msg.motion);
                        } catch (e) {
                            console.warn('Motion not found:', msg.motion);
                            playSafeMotion(currentModel, live2dRuntime.fallbackMotionName);
                        }
                    }

                    if (msg.expression) {
                        try {
                            currentModel.expression(msg.expression);
                        } catch (e) {
                            console.warn('Expression not found:', msg.expression);
                        }
                    }
                });

                if (window.electronAPI && window.electronAPI.onLive2DModelSwitched) {
                    window.electronAPI.onLive2DModelSwitched((payload) => {
                        mountModelByConfig(payload).catch((error) => {
                            console.error('Failed to apply switched model payload:', error);
                        });
                    });
                }

                if (window.electronAPI && window.electronAPI.onPanelVisibilityChanged) {
                    window.electronAPI.onPanelVisibilityChanged((payload) => {
                        setPanelOpen(Boolean(payload?.open));
                        const bubble = document.getElementById('chat-bubble');
                        if (!bubble) {
                            syncMouseIgnoreState();
                            return;
                        }
                        if (bubble.textContent) {
                            const currentModel = getCurrentModel();
                            if (currentModel) {
                                positionBubbleNearModel(currentModel);
                                positionChatToggleNearModel(currentModel);
                            }
                            bubble.style.display = 'block';
                        } else {
                            bubble.style.display = 'none';
                        }
                        syncMouseIgnoreState();
                    });
                }

                initVTubeStudioAdapter(getCurrentModel, app);
                initExternalControl(getCurrentModel);
                initWindowControl();
                initChatEntry(syncMouseIgnoreState, setPanelOpen);
                await reloadLive2DModel();

            } catch (e) {
                logError('Runtime Error: ' + e.message + '\n' + e.stack);
            }
        };

        // Helper function to remove watermark from model (Trial Version)
        // 尝试移除模型水印的辅助函数 (试用版通常会包含水印)
        function removeWatermark(model) {
            console.log('Attempting to remove watermark...');
            
            // Keywords to search for in ArtMesh names or Parameter IDs
            // 在 ArtMesh 名称或参数 ID 中搜索的关键词
            const keywords = ['watermark', 'logo', 'copyright', 'credit', 'trial', 'author', 'name', 'sign', 'text'];
            
            try {
                // 1. Check ArtMeshes (pixi-live2d-display exposes meshes)
                if (model.meshes) {
                    model.meshes.forEach(mesh => {
                        // mesh.name is usually the ArtMesh ID from Cubism Editor
                        const name = (mesh.name || '').toLowerCase();
                        
                        // Check if name contains any keyword
                        if (keywords.some(k => name.includes(k))) {
                            console.log(`Hiding mesh: ${mesh.name}`);
                            mesh.alpha = 0;      // Set opacity to 0
                            mesh.visible = false; // Hide from rendering
                        }
                    });
                }
                
                // 2. Check Parameters (Some models use a parameter to toggle watermark opacity)
                // Cubism 4 Core
                if (model.internalModel && model.internalModel.coreModel) {
                    const core = model.internalModel.coreModel;
                    // Check if getParameterCount exists (Cubism 4)
                    if (core.getParameterCount) {
                        const count = core.getParameterCount();
                        const ids = core.getParameterIds(); // Array of strings
                        
                        for (let i = 0; i < count; i++) {
                            const id = ids[i];
                            const name = id.toLowerCase(); 
                            
                            if (keywords.some(k => name.includes(k))) {
                                console.log(`Disabling parameter: ${id}`);
                                // Set parameter to 0 (usually means hidden/off)
                                core.setParameterValueByIndex(i, 0); 
                            }
                        }
                    }
                }
                
                // 3. Check Parts (Parts control visibility of groups of ArtMeshes)
                // Cubism 4 Core
                if (model.internalModel && model.internalModel.coreModel && model.internalModel.coreModel.getPartCount) {
                     const core = model.internalModel.coreModel;
                     const count = core.getPartCount();
                     const ids = core.getPartIds(); // Array of strings
                     
                     for (let i = 0; i < count; i++) {
                         const id = ids[i];
                         const name = id.toLowerCase();
                         
                         if (keywords.some(k => name.includes(k))) {
                             console.log(`Hiding part: ${id}`);
                             // Set part opacity to 0
                             core.setPartOpacityByIndex(i, 0);
                         }
                     }
                }
                
            } catch (e) {
                console.warn('Failed to remove watermark:', e);
            }
        }

        // Initialize VTube Studio Adapter (for custom parameter mapping)
        // 初始化 VTube Studio 适配器 (用于自定义参数映射)
        // This function maps standard mouse inputs to VTube Studio-specific parameters.
        function initVTubeStudioAdapter(getModel, app) {
            console.log('Initializing VTube Studio Adapter...');
            
            // 1. Auto Breathing (ParamBreath) / 自动呼吸模拟
            // VTube Studio models often use 'ParamBreath' which needs manual oscillation.
            let breathTime = 0;
            
            // 2. Mouse Tracking (Map to custom parameters) / 鼠标追踪 (映射到自定义参数)
            // VTube Studio uses specific parameters for head movement:
            // ParamAngleX2, ParamAngleX3, ParamAngleX4 (instead of standard ParamAngleX/Y/Z)
            
            let mouseX = 0; // -1 to 1 (Left to Right)
            let mouseY = 0; // -1 to 1 (Top to Bottom)
            const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
            let hasGlobalMouseFeed = false;

            const updateMouseTracking = (e) => {
                if (hasGlobalMouseFeed) return;
                // Follow cursor by window-level coordinates, not canvas hit area.
                const width = window.innerWidth || 1;
                const height = window.innerHeight || 1;
                mouseX = (e.clientX / width) * 2 - 1;
                mouseY = (e.clientY / height) * 2 - 1;
            };

            if ('onpointermove' in window) {
                window.addEventListener('pointermove', updateMouseTracking, { passive: true });
            } else {
                window.addEventListener('mousemove', updateMouseTracking, { passive: true });
            }

            if (window.electronAPI && window.electronAPI.onGlobalMouseMove) {
                window.electronAPI.onGlobalMouseMove((payload) => {
                    if (!payload || !payload.windowBounds) return;
                    hasGlobalMouseFeed = true;

                    const bounds = payload.windowBounds;
                    const width = Math.max(bounds.width || 1, 1);
                    const height = Math.max(bounds.height || 1, 1);
                    const centerX = bounds.x + width / 2;
                    const centerY = bounds.y + height / 2;

                    const normalizedX = (payload.screenX - centerX) / (width / 2);
                    const normalizedY = (payload.screenY - centerY) / (height / 2);

                    mouseX = clamp(normalizedX, -1, 1);
                    mouseY = clamp(normalizedY, -1, 1);
                });
            }
            
            // Add update loop to PixiJS ticker / 添加到 PixiJS 更新循环
            app.ticker.add((delta) => {
                const model = getModel();
                if (!model || !model.internalModel || !model.internalModel.coreModel) return;
                
                // --- Breathing Implementation / 呼吸实现 ---
                breathTime += delta * 0.05;
                const breathValue = (Math.sin(breathTime) + 1) / 2; // Oscillate 0 to 1
                setParam(model, 'ParamBreath', breathValue);
                
                // --- Head Tracking / 头部追踪 ---
                // Mapping mouse position to head angles with smoothing
                // 将鼠标位置映射到头部角度，并添加平滑处理
                
                const smoothing = 0.1; // Smoothing factor (0.1 = slow, 1.0 = instant)
                
                if (!model.adapterState) {
                    model.adapterState = {
                        headX: 0, headY: 0, headZ: 0,
                        eyeX: 0, eyeY: 0
                    };
                }
                
                // Target angles based on mouse position
                const targetHeadX = mouseX * 30;  // Max 30 degrees
                const targetHeadY = -mouseY * 30; // Invert Y for natural look
                const targetHeadZ = mouseX * 10;  // Slight tilt with horizontal movement
                
                // Apply smoothing (Linear Interpolation) / 应用平滑插值
                model.adapterState.headX += (targetHeadX - model.adapterState.headX) * smoothing;
                model.adapterState.headY += (targetHeadY - model.adapterState.headY) * smoothing;
                model.adapterState.headZ += (targetHeadZ - model.adapterState.headZ) * smoothing;
                
                // Set VTube Studio specific parameters / 设置 VTube Studio 特有参数
                setParam(model, 'ParamAngleX2', model.adapterState.headX); 
                setParam(model, 'ParamAngleX3', model.adapterState.headY); 
                setParam(model, 'ParamAngleX4', model.adapterState.headZ); 
                
                // Set standard parameters as backup / 设置标准参数作为备份
                setParam(model, 'ParamAngleX', model.adapterState.headX);
                setParam(model, 'ParamAngleY', model.adapterState.headY);
                setParam(model, 'ParamAngleZ', model.adapterState.headZ);

                // --- Eye Tracking / 眼球追踪 ---
                const targetEyeX = mouseX;
                const targetEyeY = -mouseY;
                
                model.adapterState.eyeX += (targetEyeX - model.adapterState.eyeX) * smoothing;
                model.adapterState.eyeY += (targetEyeY - model.adapterState.eyeY) * smoothing;
                
                setParam(model, 'ParamEyeBallX', model.adapterState.eyeX);
                setParam(model, 'ParamEyeBallY', model.adapterState.eyeY);
            });
        }
        
        // Helper function to safely set Live2D parameters
        // 安全设置 Live2D 参数的辅助函数
        function setParam(model, paramId, value) {
            if (model.internalModel && model.internalModel.coreModel) {
                 // Cubism 4
                 model.internalModel.coreModel.setParameterValueById(paramId, value);
            } else if (model.internalModel) {
                 // Cubism 2 or other (fallback)
                 // model.internalModel.setParamFloat(paramId, value);
            }
        }

        function initWindowControl() {
        if (!window.electronAPI) return;

        let startX, startY;
        
        window.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                // 注意：只有当 ignore=false 时（即鼠标在模型上），这里才会触发
                window.isMouseDown = true;
                window.isDragging = true;
                startX = e.screenX;
                startY = e.screenY;
                window.electronAPI.setIgnoreMouseEvents(false);
                window.electronAPI.startDrag({x: startX, y: startY});
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (window.isDragging) {
                const currentX = e.screenX;
                const currentY = e.screenY;
                window.electronAPI.drag({x: currentX, y: currentY});
            }
        });

        window.addEventListener('mouseup', () => {
             window.isMouseDown = false;
             window.isDragging = false;
             document.dispatchEvent(new CustomEvent('drag-end'));
        });

                window.addEventListener('blur', () => {
                     isLeftCtrlPressed = false;
                     window.isMouseDown = false;
                     window.isDragging = false;
                     document.dispatchEvent(new CustomEvent('drag-end'));
                });


    }

        function initChatEntry(syncMouseIgnoreState, setPanelOpen) {
            const toggleButton = document.getElementById('chat-toggle');
            if (!toggleButton) return;

            const isPointInsideRect = (x, y, rect) => {
                return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            };

            const updateUiHoverByPoint = (x, y) => {
                const toggleRect = toggleButton.getBoundingClientRect();
                const hovered = isPointInsideRect(x, y, toggleRect);

                if (hovered !== window.isUiHovered) {
                    window.isUiHovered = hovered;
                    syncMouseIgnoreState();
                }
            };

            document.addEventListener('pointermove', (event) => {
                updateUiHoverByPoint(event.clientX, event.clientY);
            }, { passive: true });

            if (window.electronAPI && window.electronAPI.onGlobalMouseMove) {
                window.electronAPI.onGlobalMouseMove((payload) => {
                    if (!payload || !payload.windowBounds) return;
                    const localX = payload.screenX - payload.windowBounds.x;
                    const localY = payload.screenY - payload.windowBounds.y;
                    updateUiHoverByPoint(localX, localY);
                });
            }

            toggleButton.addEventListener('mouseenter', () => {
                if (!window.isUiHovered) {
                    window.isUiHovered = true;
                    syncMouseIgnoreState();
                }
            });

            toggleButton.addEventListener('mouseleave', () => {
                if (window.isUiHovered) {
                    window.isUiHovered = false;
                    syncMouseIgnoreState();
                }
            });

            toggleButton.addEventListener('click', () => {
                const nextOpen = !window.isPanelOpen;
                setPanelOpen(nextOpen);
                syncMouseIgnoreState();
                if (window.electronAPI?.toggleChatPanel) {
                    window.electronAPI.toggleChatPanel();
                    return;
                }
                if (window.electronAPI && window.electronAPI.openChatPanel) {
                    if (nextOpen) {
                        window.electronAPI.openChatPanel();
                    }
                }
            });

            toggleButton.style.display = 'flex';
            toggleButton.setAttribute('aria-label', 'Chat');
            setPanelOpen(false);
            window.isUiHovered = false;
            syncMouseIgnoreState();
        }

        function initExternalControl(getModel) {
            if (window.electronAPI) {
                console.log('Electron API found. Listening for commands...');
                window.electronAPI.onCommand((data) => {
                    console.log('Received external command:', data);
                    const model = getModel();
                    if (!model) return;
                    
                    // Handle Motion
                    if (data.motion) {
                        try {
                            const safeMotionName = getSafeMotionName(data.motion);
                            playSafeMotion(model, safeMotionName);
                            console.log('Triggered motion:', safeMotionName);
                        } catch (err) {
                            console.error('Failed to trigger motion:', err);
                        }
                    }

                    // Handle Expression
                    if (data.expression) {
                         try {
                            model.expression(data.expression);
                            console.log('Triggered expression:', data.expression);
                        } catch (err) {
                            console.error('Failed to trigger expression:', err);
                        }
                    }
                    
                    // Handle Expression Reset
                    if (data.resetExpression) {
                        model.expression(null);
                    }
                });
            } else {
                console.log('Electron API not found. Running in browser mode.');
            }
        }

        // --- TTS Audio Handling ---
        const ttsAudio = document.createElement('audio');
        ttsAudio.id = 'tts-audio';
        document.body.appendChild(ttsAudio);

        let mediaSource = new MediaSource();
        let sourceBuffer = null;
        let queue = [];
        let isSourceOpen = false;
        let activeTtsJobId = null;
        let mediaSourceObjectUrl = '';

        function resetMediaSource() {
            if (ttsAudio) {
                ttsAudio.pause();
                ttsAudio.currentTime = 0;
            }
            if (mediaSourceObjectUrl) {
                URL.revokeObjectURL(mediaSourceObjectUrl);
                mediaSourceObjectUrl = '';
            }
            if (mediaSource && mediaSource.readyState === 'open') {
                try {
                    mediaSource.endOfStream();
                } catch (e) { /* ignore */ }
            }
            
            mediaSource = new MediaSource();
            mediaSourceObjectUrl = URL.createObjectURL(mediaSource);
            ttsAudio.src = mediaSourceObjectUrl;
            sourceBuffer = null;
            queue = [];
            isSourceOpen = false;
            
            mediaSource.addEventListener('sourceopen', () => {
                isSourceOpen = true;
                try {
                    if (MediaSource.isTypeSupported('audio/mpeg')) {
                        sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                        sourceBuffer.addEventListener('updateend', processQueue);
                        processQueue();
                    } else {
                        console.error('audio/mpeg not supported for MediaSource');
                    }
                } catch (e) {
                    console.error('AddSourceBuffer error', e);
                }
            });
        }

        function processQueue() {
            if (queue.length > 0 && sourceBuffer && !sourceBuffer.updating) {
                try {
                    sourceBuffer.appendBuffer(queue.shift());
                } catch (e) {
                    console.error('AppendBuffer error', e);
                    if (e.name === 'QuotaExceededError') {
                        resetMediaSource();
                    }
                }
            }
        }

        // Initialize
        resetMediaSource();

        window.addEventListener('beforeunload', () => {
            if (mediaSourceObjectUrl) {
                URL.revokeObjectURL(mediaSourceObjectUrl);
                mediaSourceObjectUrl = '';
            }
        });

        function hexToUint8Array(hex) {
            if (!hex) return new Uint8Array(0);
            const len = hex.length;
            const bytes = new Uint8Array(len / 2);
            for (let i = 0; i < len; i += 2) {
                bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
            }
            return bytes;
        }

        if (window.electronAPI && window.electronAPI.onTTSChunk) {
            window.electronAPI.onTTSChunk((hexChunk) => {
                const bytes = hexToUint8Array(hexChunk);
                queue.push(bytes);
                
                if (isSourceOpen) {
                    processQueue();
                }

                if (ttsAudio.paused) {
                    ttsAudio.play().catch(e => console.error('Play error', e));
                }
            });
        }

        if (window.electronAPI && window.electronAPI.onTTSEnd) {
            ttsAudio.addEventListener('ended', () => {
                const bubble = document.getElementById('chat-bubble');
                if (bubble) bubble.style.display = 'none';
                if (window.electronAPI && window.electronAPI.notifyTTSPlaybackEnded) {
                    window.electronAPI.notifyTTSPlaybackEnded(activeTtsJobId);
                }
            });

            window.electronAPI.onTTSEnd((payload) => {
                activeTtsJobId = payload?.jobId ?? null;
                try {
                    // End current MediaSource so <audio> can fire 'ended'.
                    if (mediaSource && mediaSource.readyState === 'open') {
                        if (sourceBuffer && sourceBuffer.updating) {
                            const handler = () => {
                                try {
                                    if (mediaSource && mediaSource.readyState === 'open') {
                                        mediaSource.endOfStream();
                                    }
                                } catch (e) { /* ignore */ }
                            };
                            sourceBuffer.addEventListener('updateend', handler, { once: true });
                        } else {
                            mediaSource.endOfStream();
                        }
                    }
                } catch (e) {
                    // ignore
                }
            });
        }

