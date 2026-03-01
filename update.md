# Development Update Log

## 2026-03-02 Update

### Features & Fixes

1.  **VTube Studio Model Adaptation**:
    *   Implemented `initVTubeStudioAdapter` to support models designed for VTube Studio.
    *   Mapped mouse movements to VTube Studio-specific parameters (`ParamAngleX2`, `ParamAngleX3`, `ParamAngleX4`, `ParamEyeBallX`, `ParamEyeBallY`).
    *   Added auto-breathing simulation (`ParamBreath`).

2.  **Virtual Expression System**:
    *   Created a virtual expression system allowing the model to show emotions (Happy, Sad, Surprised, Angry) via parameter overrides.
    *   Prioritized virtual expressions over default parameter updates.

3.  **Motion System Improvements**:
    *   Added `Idle` and `TapBody` motion groups to `model3.json` to ensure basic motions work.
    *   Implemented a fallback mechanism to force `Idle` motion on load.

4.  **Visual & Layout Adjustments**:
    *   **Fixed Scale & Position**: The model is now locked to a specific scale (showing upper 2/3) at initialization. Window resizing no longer affects model scale, only its position (centering).
    *   **Debug Border**: Added a visible green border (`#ddf904`) to the window for easier debugging and area visualization.
    *   **Disabled Wheel Zoom**: Removed mouse wheel zoom functionality to maintain consistent model presentation.
    *   **Watermark Removal**: Added `removeWatermark` function to attempt hiding potential watermark parts/parameters for trial version models.

### Technical Details
*   Modified `src/renderer/index.html` to include the adapter logic and resize handlers.
*   Updated `assets/Jellyfish/星月水母 试用版.model3.json` to register motion groups.
