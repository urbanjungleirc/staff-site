# Google Drive Slideshow - Developer Handoff

## Project Overview
A fullscreen slideshow web application that displays content from a Google Drive folder on TV browsers. Supports images, videos, and dynamic leaderboards for climbing competitions.

## Current Implementation Status ✅
- **Complete HTML slideshow** with Google OAuth integration
- **Alphabetical file ordering** (user requirement)
- **Custom duration control** via filename prefixes: `[30]image.jpg`
- **Professional leaderboard styling** with modern pipe formatting: "Male Youth | 13-18yo"
- **Dynamic leaderboard backgrounds** with alternating left/right placement
- **Live competition data integration** via Google Apps Script endpoint
- **File description-based configuration** (no longer needs Google Sheets)
- **OAuth authentication** with folder browser interface
- **Auto-refresh with slideshow persistence** (no re-login required)
- **Error handling** for access issues and missing files
- **Fullscreen responsive design**
- **Smooth transitions** between slides with fade effects
- **Smart title/description parsing** from Google Drive file descriptions
- **Flexible leaderboard filename detection** (any file containing "leaderboard")
- **One-time data loading** for optimal performance during slideshow
- **Keyboard controls** (Escape to exit, F11 fullscreen, manual navigation)
- **Background image system** for enhanced leaderboard presentation

## Project Structure
```
project/
├── index.html              # Main slideshow application - PRODUCTION READY
├── result.html            # Competition results table (separate tool)
├── config.md              # Configuration template (reference only, not used by app)
├── CLAUDE.md              # This handoff document
└── README.md              # Complete setup instructions (UPDATED)
```

## Key Requirements & Implementation Details

### 1. Content Display Order
- **ALPHABETICAL by filename** (user specifically requested this over content type grouping)
- All files (images, videos, leaderboards) mixed together alphabetically
- Example: `aaa-image.jpg`, `bbb-video.mp4`, `ccc-leaderboard_speed.md`

### 2. Duration Control System
**Implementation: Filename prefixes**
```
[30]my-image.jpg          → 30 seconds display
[5]quick-message.png      → 5 seconds display  
my-regular-image.jpg      → Default duration (10s)
video.mp4                 → Full length playback
```
User chose this approach as "easiest for non-technical users"

### 3. Enhanced Leaderboard System ✅ UPDATED
**Trigger Files:** Place `.md` files in Drive folder to trigger leaderboard slides
- `leaderboard_speed.md` → Speed climbing leaderboard
- `leaderboard_rainbow.md` → Rainbow route leaderboard  
- `leaderboard_opens.md` → Opens category leaderboard

**Background Images:** Place images with `leaderboard_bg` in filename for dynamic backgrounds
- `leaderboard_bg1.jpg` → Primary climbing background
- `leaderboard_bg_action.png` → Action shot background
- `leaderboard_bg_wall.jpg` → Climbing wall background

**Enhanced Visual Features:**
- **Dynamic layout**: 33% background area | 66% content area
- **Alternating placement**: Backgrounds alternate left/right between slides
- **Professional styling**: Full-height backgrounds with gradient fade effects
- **Dual-column content**: Smart table distribution within content area
- **Modern formatting**: Pipe separator format "Male Youth | 13-18yo"
- **Custom colors**: Per-category header colors (#cc0000, #ff8800, etc.)
- **Ranking display**: Numbers, names, times with professional styling
- **Background cycling**: Multiple background images rotate automatically

### 4. Configuration System ✅ IMPLEMENTED
**Method:** File descriptions in Google Drive (no external files needed)

**Global Settings:** Create `settings.txt` in folder, add config to file description:
```
default_slide_duration_seconds: 8
slideshow_title: UJ Slideshow  
slideshow_auto_reload_minutes: 5
default_leaderboard_row_limit: 12
default_leaderboard_data_url: your-custom-endpoint
```

**Leaderboard Config:** Add to each leaderboard `.md` file description:
```
title: Speed Championship
route_type: Official Speed
limit: 12

table: Male Youth | 13-18yo
gender: Male
category: youth
color: #cc0000
limit: 10
```

### 5. OAuth Authentication System ✅ IMPLEMENTED
**User Experience:**
```
1. Open index.html → Google OAuth login screen
2. Authenticate with Google Drive account
3. Browse and select slideshow folder from interface
4. Click green button to start slideshow
```

**Features:**
- **Domain restriction**: Only authorized domains can access (configurable)
- **Session persistence**: Authentication survives auto-refreshes
- **Folder browser**: Search, sort, and preview folder contents
- **Direct slideshow restart**: Auto-refresh resumes slideshow without re-login
- **Escape key**: Exit slideshow and return to folder selection
- **Clean logout**: Proper token revocation and state cleanup

### 6. Title/Description System ✅ IMPLEMENTED
- Uses Google Drive file descriptions for overlay content
- **Single paragraph**: Shows as description only
- **Multiple paragraphs**: First paragraph = title, rest = description
- **No description**: No overlays shown (clean display)

### 7. Smooth Transitions ✅ IMPLEMENTED  
- 0.8s fade transitions between slides
- Staggered overlay animations (title appears first, then description)
- Cross-fade prevents jarring content switches

## Technical Architecture

### Current Implementation
- **Client-side only** - No backend required
- **Google Drive API v3** for file listing and content access
- **Vanilla JavaScript** - No frameworks
- **CSS Grid/Flexbox** for responsive leaderboard layouts
- **HTML5 Video** for full-length video playback

### API Integration Points
1. **Google Drive API:**
   - List files in folder: `/drive/v3/files?q='FOLDER_ID'+in+parents`
   - Download images: `/uc?id=FILE_ID&export=download`
   - Embed videos: `/file/d/FILE_ID/preview`

2. **Google Apps Script Integration (IMPLEMENTED):**
   - Live data endpoint: `https://script.google.com/macros/s/AKfycbwBLixPo5OGRVEraXVgdbe_Crndrt9KdypZVb13RZFM-ul6XLO4lR3npHk2FLf2tM0WQw/exec?json`
   - One-time data loading at slideshow startup
   - Shared dataset filtered for each leaderboard slide

### File Type Processing ✅ UPDATED
```javascript
// Current logic in getFileType() - FLEXIBLE DETECTION
if (name.includes('leaderboard') && name.endsWith('.md')) return 'leaderboard';
if (mimeType.startsWith('image/')) return 'image';
if (mimeType.startsWith('video/')) return 'video';
return 'unsupported';
```
**Supports flexible naming:** `leaderboard_speed.md`, `11 leaderboard kids.md`, etc.

## ✅ RESOLVED - Configuration System Working

### Solution Implemented
The Google Sheets API issues were bypassed by implementing a **file description-based configuration system** that's actually better for users:

**Benefits of Current Approach:**
- ✅ **No API complications** - Uses existing Google Drive API only
- ✅ **Simpler for staff** - Edit file descriptions directly in Google Drive
- ✅ **No external dependencies** - Everything contained within the Drive folder
- ✅ **Better organization** - Settings stored with the actual content

**Working Test URL:** `index.html?folder=1lfEFF0OfRVj1w24LdsmT3grXGrn6-dJB&key=AIzaSyAL0c1mpOJImMGiDA6XtMV2aPA2mWgdrJE`

## Current Working Features ✅

### 1. Basic Slideshow Functionality
- ✅ **Images load perfectly** using Google Drive thumbnail API
- ✅ **Videos work** with Drive preview URLs  
- ✅ **Leaderboards display** with sample data
- ✅ **Alphabetical ordering** by filename
- ✅ **Duration control** via `[30]filename.jpg` prefixes
- ✅ **Smooth transitions** with fade effects

### 2. Live Data Integration ✅ WORKING
- ✅ **Google Apps Script integration** - Live competition data loading
- ✅ **File description config** - No Google Sheets API needed
- ✅ **One-time data loading** - Optimal performance during slideshow
- ✅ **Smart filtering** - Each leaderboard shows different categories from shared dataset

## Future Enhancement Opportunities (Optional)

### 1. Enhanced Real-time Updates 🔄 OPTIONAL
Current system loads data once at startup. Could add:
- Periodic refresh during slideshow (every 5-10 minutes)
- WebSocket integration for live updates
- Visual indicators when new data is loaded

### 2. Advanced Competition Features 🏆 OPTIONAL
- Multiple competition support in single slideshow
- Route-specific leaderboards with different data sources
- Automatic category detection from live data

### 3. Production Deployment Prep 🔥 MEDIUM PRIORITY
- Create comprehensive setup documentation
- Add error logging/debugging for troubleshooting
- Test with various folder permissions and file types
- Mobile/tablet responsive testing for different TV browsers

### 4. Advanced Features (Future Enhancement)
- Real-time data updates during live competitions
- Enhanced transition animations between slides
- Remote control via URL parameters or admin interface
- Multiple folder support for different events
- Offline mode with cached data for network issues

## User Context & Domain
**Industry:** Climbing competitions (speed climbing, route climbing)
**Use Case:** TV displays at climbing gyms showing live leaderboards mixed with photos/videos
**Users:** Non-technical gym staff who need to easily update display duration by renaming files
**Environment:** TV browsers, fullscreen display, unattended operation

## Critical User Feedback & Requirements
1. **"alphabetically based on the name of the file"** - ✅ IMPLEMENTED (don't change)
2. **Filename duration control is "best and easiest approach"** - ✅ IMPLEMENTED (keep this system)
3. **Leaderboard styling** - ✅ IMPLEMENTED (user provided exact visual examples)
4. **Google Sheets data "changes regularly"** - ⚠️ NEEDS FIXING (real-time config + data essential)
5. **"Easy for staff to change settings"** - ⚠️ BLOCKED (Google Sheets config not loading)
6. **Smooth transitions** - ✅ IMPLEMENTED (fade effects between slides)
7. **Smart title/description** - ✅ IMPLEMENTED (parses from Drive file descriptions)

## Sample Data Structures

### Leaderboard Categories (from user examples):
```javascript
// Speed Leaderboard
categories: [
  {
    name: "Male Youth 13-18 yo",
    color: "#cc0000",
    data: [
      { rank: 1, name: "Max Botica", time: "4.690" },
      // ... more competitors
    ]
  },
  {
    name: "Female Youth 13-18 yo", 
    color: "#cc0000",
    data: [
      { rank: 1, name: "Christel Kotze", time: "9.930" },
      // ... more competitors  
    ]
  }
]
```

## Error Handling Requirements
- **Folder not accessible:** "Access denied" message
- **Missing config.md:** "Configuration missing" or use defaults
- **Empty folder:** "No content found"  
- **API failures:** Graceful degradation with error display
- **Malformed files:** Skip and continue slideshow

## Browser Compatibility
Target: **TV browsers** (often older, limited JavaScript support)
- Avoid modern ES6+ features where possible
- Test on older Android TV, Smart TV browsers
- Ensure video codec compatibility
- Handle slow network conditions

## Contact & Resources
- **Original conversation:** Full requirements and user examples available
- **Visual references:** 3 leaderboard example images provided by user
- **Google Drive folder structure:** User will create public test folder
- **Google Sheets:** User has existing competition data sheets

## Latest Development Session Summary (January 2025)

### ✅ COMPLETED - All Issues Resolved:
1. **User-friendly configuration variables** - Renamed settings to clear, descriptive names like `default_slide_duration_seconds`
2. **Full-screen image display** - Images now stretch to fill entire screen without letterboxing
3. **Modern pipe separator format** - Leaderboard titles use `Male Youth | 13-18yo` instead of brackets  
4. **Enhanced auto-reload system** - Configurable slideshow refresh via `slideshow_auto_reload_minutes`
5. **Comprehensive time formatting** - All times display in consistent 0.000 format
6. **Fixed keyboard controls** - Arrow keys and spacebar navigation working properly
7. **Smart two-column leaderboard layout** - Intelligent table distribution based on content size
8. **Fixed slide content duplication issue** - Each slide now displays unique content correctly
9. **Enhanced file type handling** - Separate processing for leaderboards vs images/videos
10. **Live data integration** - Real-time competition data via Google Apps Script endpoint
11. **File description configuration** - Bypassed Google Sheets API issues entirely
12. **Flexible leaderboard detection** - Any filename containing "leaderboard" works
13. **One-time data loading** - Optimal performance with startup data caching
14. **Professional styling** - Modern leaderboard design with gradient headers and animations

### ✅ Production Status:
**FULLY OPERATIONAL** - No blockers remaining

### 🔧 Current Working Configuration:
- **Access Method**: OAuth authentication via `index.html` (no URL parameters needed)
- **Live Data Endpoint**: `https://script.google.com/macros/s/AKfycbwBLixPo5OGRVEraXVgdbe_Crndrt9KdypZVb13RZFM-ul6XLO4lR3npHk2FLf2tM0WQw/exec?json`
- **Configuration Method**: Google Drive file descriptions (no external APIs needed)
- **Default Duration**: 10 seconds (configurable via `default_slide_duration_seconds` in settings.txt file description)
- **Auto-reload**: 5 minutes (configurable via `slideshow_auto_reload_minutes`)
- **Image Display**: Full-screen stretch mode (no letterboxing)
- **Leaderboard Format**: Modern pipe separator - `Male Youth | 13-18yo`
- **Background System**: Dynamic alternating backgrounds for leaderboard slides

### 📁 Final File Status:
- `index.html` - **PRODUCTION READY** - Complete slideshow with all features working
- `result.html` - Competition results table (separate utility)
- `README.md` - **COMPREHENSIVE** - Complete setup guide for users  
- `CLAUDE.md` - **UPDATED** - This handoff document with current status

### 🏆 Key Achievements:
- **Implemented Google OAuth** replacing manual API key management
- **Created dynamic leaderboard backgrounds** with alternating left/right placement
- **Added slideshow persistence** through auto-refresh without re-login
- **Built comprehensive folder browser** with search, sort, and preview
- **Enhanced user experience** with Escape key navigation and clean state management
- **Solved Google Sheets API issues** by implementing superior file description approach
- **Fixed all reported bugs** including slide duplication and bracket formatting
- **Integrated live competition data** with optimal performance architecture
- **Created production-ready system** that's easy for staff to manage
- **Provided complete documentation** for users and future developers

---

## 🆕 Latest Development Session (January 2025) - OAuth & Enhanced Backgrounds

### ✅ COMPLETED - Major Feature Updates:
1. **Google OAuth Integration** - Replaced manual API key entry with secure OAuth flow
2. **Folder Browser Interface** - Professional UI for folder selection with search/sort
3. **Slideshow Persistence** - Auto-refresh maintains slideshow without re-authentication
4. **Dynamic Leaderboard Backgrounds** - Alternating left/right placement with blur effects
5. **Enhanced User Controls** - Escape key navigation, clean state management
6. **Background Image System** - Supports `leaderboard_bg*` files for dynamic presentation
7. **Improved Loading States** - Better spinners and visual feedback during transitions

### 🎨 Enhanced Leaderboard System:
- **33% background area** | **66% content area** layout
- **Alternating sides**: Left → Right → Left pattern between slides
- **Full-height backgrounds** with professional gradient fade effects
- **Multiple background support**: Cycles through `leaderboard_bg1.jpg`, `leaderboard_bg2.png`, etc.
- **Preserved functionality**: All existing features maintained

---

## 🔄 Latest Development Session (January 2025) - Continuous Operation System

### ✅ COMPLETED - Continuous Slideshow Implementation:

**Problem Solved:** User logout after ~1 hour causing slideshow interruption during long-running displays.

**Solution Implemented:**
1. **Simplified Authentication** - Reverted complex token refresh to proven OAuth pattern
2. **Soft Reload System** - Replaced `window.location.reload()` with content-only refresh
3. **Seamless Continuation** - Slideshow continues from next slide after content updates
4. **Enhanced Error Handling** - Graceful fallback when refresh operations fail
5. **Production Testing** - Verified continuous operation without user intervention

### 🚀 Continuous Operation Features:
- ✅ **Runs indefinitely** - No authentication timeouts or user logout
- ✅ **Auto-refresh content** - Updates slides, leaderboards, and config automatically
- ✅ **Soft reload technology** - Refreshes data without breaking slideshow flow
- ✅ **State preservation** - Remembers playback position through content updates
- ✅ **Error resilience** - Continues operation even if periodic updates fail
- ✅ **Configurable intervals** - Customizable refresh timing via `slideshow_auto_reload_minutes`

### 🎯 Technical Implementation:
- **Authentication**: Simple OAuth flow without complex token management
- **Content Updates**: `setInterval()` with `loadFolder()` and `loadLeaderboardData()`
- **Slideshow Continuity**: Preserves `isPlaying` state and `currentIndex` through refreshes
- **Memory Management**: Clears timouts and prevents memory leaks during updates
- **Logging**: Comprehensive console tracking for debugging and monitoring

### 📈 Perfect for Production:
- **24/7 Operation**: Suitable for competition displays, gyms, events
- **Staff-Friendly**: No technical intervention needed during events
- **Real-time Updates**: Leaderboards and content sync automatically
- **Robust Performance**: Handles network issues and API failures gracefully

### ⚙️ Configuration:
```
slideshow_auto_reload_minutes: 10    # Content refresh frequency
default_slide_duration_seconds: 8    # Individual slide timing
slideshow_title: Competition Display  # Display title
```

**Recommended for competitions:**
- 5-15 minute refresh intervals for live leaderboard data
- Test with shorter intervals first, then extend for stability
- Monitor console logs during first deployment to verify operation

---

**Status: CONTINUOUS OPERATION READY ✅ - Slideshow now runs indefinitely without user intervention, automatically updating content while maintaining uninterrupted display. Perfect for professional TV displays at competitions and events requiring 24/7 operation.**

---

## 📋 Planned Enhancements - Next Development Session

### 🎯 Priority Features for Next Session:

#### 1. Help/How-To Section 📚
**Location:** Main page (folder browser screen)
**Purpose:** Guide non-technical staff through slideshow setup and usage

**Proposed Content:**
- Quick start guide for first-time users
- Filename duration syntax examples: `[30]image.jpg`
- How to add titles/descriptions via Google Drive file descriptions
- Leaderboard configuration examples
- Troubleshooting common issues
- Keyboard shortcuts reference

**Implementation Ideas:**
- Collapsible help panel with icon/button
- Modal dialog with tabbed sections
- Link to comprehensive README.md
- Inline tooltips on folder browser interface

#### 2. File Management Editor 🔧
**Purpose:** Simplify content management without leaving the slideshow interface

**Core Features:**
- **Rename files** - Edit filename (including duration prefix) inline
- **Edit descriptions** - Modify titles/descriptions without opening Google Drive
- **Drag & drop reordering** - Visual file reordering (updates filenames with alphabetical prefixes)
- **Preview mode** - See changes before applying
- **Batch operations** - Update multiple files at once

**Technical Considerations:**
- Uses Google Drive API v3 file update endpoints
- Requires write permissions (`drive.file` scope in OAuth)
- Real-time validation for duration syntax
- Undo/redo functionality for safety
- Auto-save vs manual save options

**UI Design:**
- Modal editor accessible from folder browser
- Split view: file list on left, editor panel on right
- Drag handles for reordering with visual feedback
- Color-coded file types (images, videos, leaderboards)

#### 3. Image Cropping Tool ✂️
**Purpose:** Prepare images for TV display without external editing software

**Features:**
- **Preset aspect ratios** for common TV formats:
  - 16:9 (Full HD, 4K standard)
  - 21:9 (Ultrawide)
  - 4:3 (Older displays)
  - Custom ratios
- **Live preview** showing how image will appear in slideshow
- **Zoom/pan controls** for precise framing
- **Multiple crops per image** - Save variations with different names
- **Non-destructive editing** - Creates new files, preserves originals

**Technical Implementation:**
- Canvas API for client-side image manipulation
- Upload new cropped versions to Google Drive
- Filename suffix convention: `image_16-9.jpg`, `image_4-3.jpg`
- Optional: Store crop metadata in file description for re-editing

**User Workflow:**
1. Select image from file list
2. Choose aspect ratio preset or custom
3. Adjust crop area with visual handles
4. Preview in slideshow context
5. Save cropped version to Drive folder
6. Option to set duration for new file

### 🎨 Additional Considerations:

**Integration Points:**
- All three features accessible from main folder browser interface
- Unified navigation between help, editor, and cropping tools
- Consistent design language with existing slideshow UI

**User Experience:**
- Minimize need to switch between slideshow and Google Drive web interface
- Simple, visual controls suitable for non-technical staff
- Mobile/tablet friendly for on-the-go content management

**Performance:**
- Lazy-load editor components to keep main app lightweight
- Client-side operations where possible to reduce API calls
- Progress indicators for file uploads/updates

**Documentation:**
- Update README.md with new feature guides
- Add inline help text within each tool
- Video tutorials for complex workflows (optional)

### 📝 Implementation Priority:
1. **Help section** (Quick win, high user value)
2. **File editor** (Core functionality, moderate complexity)
3. **Cropping tool** (Advanced feature, higher complexity)

---

**Next Session Goals:** Implement help section first to improve onboarding, then evaluate user feedback before starting file editor and cropping features.