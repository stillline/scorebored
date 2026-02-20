# ATEM Switcher Integration Configuration

## Overview

The scoreboard system now includes full ATEM switcher integration for automated video production workflows. When playing commercial break videos, the system will:

1. **Before Video**: Fade out downstream key → Switch to graphics input
2. **After Video**: Switch back to previous camera → Fade in downstream key

## Environment Variables

Configure your ATEM switcher by setting these environment variables:

```bash
# ATEM Switcher IP Address (default: 192.168.1.240)
export ATEM_IP=192.168.1.240

# Graphics/Scoreboard Input Number (default: 6)
export GRAPHICS_INPUT=6

# Downstream Key Number to Control (default: 1)
export DOWNSTREAM_KEY=1
```

## Default Configuration

- **ATEM IP**: `10.42.0.100`
- **Graphics Input**: Input 1 (relabeled as "Graphics" in your multiview)
- **Downstream Key**: DSK 1 (used for overlays like scoreboard graphics)

## Setup Instructions

### 1. ATEM Switcher Setup

1. Your **Input 1** is set up as graphics/video feed (relabeled as "Graphics" in multiview)
2. Configure **Downstream Key 1** with your overlay settings:
   - Set the DSK to use the scoreboard input as the key source
   - Configure chroma/luma key settings as needed
   - Test the DSK manually first to ensure proper keying

### 2. Network Configuration

1. Ensure your ATEM switcher and Pi are on the same network
2. Note your ATEM's IP address (check ATEM Software Control)
3. Update the `ATEM_IP` environment variable if different from default

### 3. Input Assignment

- **Input 1**: Graphics/video feed (relabeled as "Graphics" in your multiview)
- **Input 2-6**: Your camera inputs
- **DSK 1**: Scoreboard overlay key

## Usage

### Automatic Control (Commercial Breaks)

When you start a commercial break from the control panel, the system automatically:

1. **Pre-Video Sequence**:
   - Turn OFF DSK 1 (removes scoreboard overlay)
   - Switch program output to Input 1 (graphics/video feed)

2. **Post-Video Sequence**:
   - Switch program output back to previous camera
   - Turn ON DSK 1 (restores scoreboard overlay)

### Manual Control

The control panel now includes an ATEM section with:

- **Connection Status**: Shows if ATEM is connected
- **Connect ATEM Button**: Manually reconnect to ATEM
- **Input Switching**: Buttons to switch between inputs 1-6
- **Downstream Key Control**: Toggle DSK 1 on/off

## Troubleshooting

### ATEM Not Connecting

1. **Check Network**: Ensure Pi and ATEM are on same network
2. **Verify IP**: Confirm ATEM IP address in ATEM Software Control
3. **Firewall**: Ensure no firewall blocking port 9910
4. **ATEM Model**: Ensure you have a supported ATEM model

### Manual Connection

If automatic connection fails on startup:

1. Open the control panel: `http://[pi-ip]:3000/control`
2. Look for the "ATEM Switcher Control" section
3. Click "Connect ATEM" button
4. Status should change to "Connected" if successful

### Input Configuration

If wrong inputs are used:

1. **Change Graphics Input**:
   ```bash
   export GRAPHICS_INPUT=4  # If using input 4 instead
   ```

2. **Change Downstream Key**:
   ```bash
   export DOWNSTREAM_KEY=2  # If using DSK 2 instead
   ```

3. Restart the server: `systemctl restart scorebored`

## Status Information

When the server starts, you'll see:

```
ATEM IP: 192.168.1.240 | Graphics Input: 6 | Downstream Key: 1
```

The control panel shows real-time ATEM status:
- Connection state (Connected/Disconnected)
- Current active input (highlighted button)
- Downstream key state (ON/OFF)

## Workflow Example

**Production Workflow**:

1. **Normal Operation**:
   - Camera feed on program output
   - Scoreboard overlay active via DSK 1 (ON)

2. **Commercial Break**:
   - Operator clicks "Start Break" with selected video
   - ATEM turns OFF DSK 1 (removes scoreboard overlay)
   - ATEM switches to Input 1 (graphics input) showing video
   - Video plays fullscreen

3. **Return from Break**:
   - Video ends or operator clicks "Stop Break"
   - ATEM switches back to previous camera
   - ATEM turns ON DSK 1 (restores scoreboard overlay)
   - Normal production resumes

## Advanced Configuration

For custom ATEM setups, modify the server.js configuration:

```javascript
// Custom transition timing
await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second pause

// Custom fade rates (if supported by ATEM model)
await fadeDownstreamKey(true, 2000); // 2 second fade
```

## Supported ATEM Models

This integration works with ATEM models that support:
- Ethernet control (most modern ATEMs)
- Downstream keyers
- Program input switching

Tested with: ATEM Mini Pro, ATEM Mini Extreme, ATEM Television Studio