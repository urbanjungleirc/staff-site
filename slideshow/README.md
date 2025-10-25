# Google Drive Slideshow

Fullscreen slideshow for TV displays with live speed leaderboards and dynamic backgrounds. Shows images, videos, and real-time competition data from Google Drive with OAuth authentication.

**How it works:**

* Slideshow runs continuously through all slides (acceptable files) in alphabetical order  
* Every N minutes (configurable via `slideshow_auto_reload_minutes`), content refreshes automatically  
* New files, updated leaderboards, and config changes are picked up automatically  
* If refresh fails, slideshow continues uninterrupted with existing content  
* Accepted files are pictures, videos and a leaderboard setting file.

## Opening the slideshow

1. **Google OAuth**: Open `https://tools.urbanjungleirc.com/slideshow/index.html` and authenticate with Google Drive
2. **Previous Session Detection**: If you were previously running a slideshow, a popup will appear asking if you want to resume
3. **Select Folder**: Choose your slideshow folder from the browser interface
4. **Start Slideshow**: Click the green button to begin the presentation (automatically goes fullscreen)

## Configuration

Use the `settings.txt` file in the Google Drive folder and add the desired config to the file **description** (not inside the file, but in the description of the file):

```
default_slide_duration_seconds: 10
slideshow_auto_reload_minutes: 5
default_leaderboard_row_limit: 12
resume_session_timeout_seconds: 30
slideshow_title_slide_enabled: false
slideshow_title_slide_duration: 10
```

Slides are always displayed **alphabetically** \- use `01_`, `02_` prefixes to control order.

## Title Slide Feature

**Professional opening slide with automatic image collage:**

When enabled, the slideshow displays a beautiful title slide as the first slide, featuring:

- **Large centered title** using the `slideshow_title` setting
- **Image collage background** automatically generated from folder images
- **Professional styling** with blurred, darkened background and overlay
- **Fallback design** uses gradient background if no images are available

**Configuration:**

```
slideshow_title: "Competition Finals 2024"    # Title text to display
slideshow_title_slide_enabled: true           # Enable/disable title slide
slideshow_title_slide_duration: 15            # How long to show title slide
```

**Features:**

- **Automatic collage**: Selects up to 6 images evenly distributed from your folder
- **Dynamic updates**: Refreshes with new images when slideshow reloads
- **Order preservation**: Always appears first, before alphabetical content
- **Responsive design**: Adapts to different screen sizes

**Perfect for:**
- Competition displays
- Event presentations
- Professional slideshows
- TV displays with branding

## Accepted Files

### Images 

* Will be automatically displayed stretched to fill the screen  
* Accepted JPG and PNG files   
* Upload in 16:9 ratio, ideally 1920 x 1080px   
* Keep the size under 1MB for performance

**Available setting**:

In the file name

* Use a number in square brackets to override the default duration, e.g.. `[30]image.jpg` \= 30 seconds

In the file description

* Images can have a title and description overlay automatically generated from the file description.  
* **No content**: No overlay displayed  
* **Single line**: Shows as title only  
* **Multiple lines**: First line = title, remaining lines = description  
* Lines containing settings (with colons) are filtered out and won't be displayed  
* Add `duration: 15` to any file's description to override default duration the slide is shown

### Videos 

* Will be played full-length with audio  
* Accepted MP4 and MOV files  
* Don’t overdo it, ideally a few seconds only

### Leaderboard files

* **Leaderboards** placeholder is any filename containing "leaderboard.md"  
* These place holders will display leaderboards based on the setting saved in the file's description (see below)  
* **Background Images** are files with a filename containing "leaderboard\_bg"): These images won’t be displayed as individual slides but as alternating backgrounds for leaderboard slides

#### Leaderboards

Create `.md` files with "leaderboard" in the filename. Add config to file **description**:

```
title: Rainbow route
duration: 15

table: Male Youth | 13-18yo
gender: Male
category: youth
color: #cc0000
limit: 10

table: Female Youth | 13-18yo  
gender: Female
category: youth
color: #cc0000
limit: 15
```

**An automatic layout:**

- **Slide 1**: Background LEFT (33%) | Content RIGHT (66%)  
- **Slide 2**: Content LEFT (66%) | Background RIGHT (33%)  
- **Slide 3**: Background LEFT (33%) | Content RIGHT (66%) (repeats pattern)

**Available options:**

* `gender`: Male, Female, or blank (all)  
* `category`: open, youth, kids, masters  
* `color`: Header colour (\#cc0000)  
* `limit`: Number of competitors to show

#### Leaderboard Backgrounds

* **Images** with `leaderboard_bg` in filename (e.g., `leaderboard_bg1.jpg`, `leaderboard_bg_climbing.png`) Dynamic backgrounds to leaderboard slides:  
* **Automatic alternating**: Backgrounds alternate left/right between slides for visual variety  
* **Professional styling**: Full-height images with blur fade effects toward center  
* **Content focus**: Leaderboard tables remain clearly visible (66% screen width)

## Example Folder

```
📁 Competition Slideshow/
├── settings.txt (config in description - enable title slide here)
├── 01_welcome.jpg
├── [30]02_announcement.png
├── leaderboard_speed.md (config in description)
├── leaderboard_bg1.jpg (background image)
├── leaderboard_bg_climbing.png (background image)
└── 03_closing.mp4

# With title slide enabled, playback order becomes:
# 1. Title Slide (auto-generated collage + title)
# 2. 01_welcome.jpg
# 3. [30]02_announcement.png
# 4. 03_closing.mp4
# 5. leaderboard_speed.md
# 6. Loop back to title slide
```

## Duration Control logic

1. **Filename**: `[30]image.jpg` \= 30 seconds  
2. **File description**: Add `duration: 15` to any file's description  
3. **Default**: Uses global setting (10 seconds)

## Troubleshooting

- **Config not working**: Put settings in file **description**, not file content  
- **Leaderboards not showing**: Filename must contain "leaderboard" and end with `.md`

## Continuous Display Features

**Perfect for unattended TV displays and long-running competitions:**

- ✅ **Runs indefinitely** \- No user logout or interruption  
- ✅ **Auto-refresh content** \- Updates slides and data without breaking slideshow  
- ✅ **Soft reloads** \- Refreshes content seamlessly, continues playing from next slide  
- ✅ **Token management** \- Handles authentication automatically in background  
- ✅ **Error resilience** \- Continues playing even if occasional updates fail

## TV Display Setup

1. **Open slideshow** and authenticate with Google Drive
2. **Resume previous session** (if available) or **select folder** for new slideshow
3. **Start slideshow** \- automatically enters fullscreen mode when started
4. **Leave running** \- slideshow will continue indefinitely
5. **Disable sleep mode** on computer/TV for 24/7 operation

**Key controls:**

- **F11**: Toggle fullscreen
- **Escape**: Exit slideshow → return to folder browser
- **Arrow Right / Spacebar**: Manual next slide
- **Auto-loop**: Automatically restarts from first slide after reaching end

## Resume Session Feature

**Perfect for multi-tab workflows and unattended displays:**

When you reopen the slideshow (browser refresh, new tab, etc.), the system automatically detects if you were previously running a slideshow and shows a **resume session popup**:

- **Shows folder name** so you know which session you're resuming
- **Two options**: "Resume Slideshow" or "Start Fresh Session"
- **Auto-timeout**: Automatically resumes after configurable seconds (default: 30)
- **Multi-tab safe**: Each browser tab operates independently

**Use cases:**

- **Staff present**: Choose "Resume" or "Start Fresh" manually
- **Unattended TV**: Auto-resumes after timeout for continuous operation
- **Multiple tabs**: Different slideshows can run in different tabs
- **Browser refresh**: Seamlessly continues where you left off

**Configuration:**

```
resume_session_timeout_seconds: 30   # Auto-resume after 30 seconds
resume_session_timeout_seconds: 10   # Quick resume for competitions
resume_session_timeout_seconds: 0    # Manual choice only (no auto-resume)
```

## Configuration for Continuous Operation

In your `settings.txt` file description:

```
default_slide_duration_seconds: 8
slideshow_auto_reload_minutes: 10    # Refresh content every 10 minutes
slideshow_title: My Competition Display
default_leaderboard_row_limit: 12
resume_session_timeout_seconds: 30   # Auto-resume previous session after 30 seconds
slideshow_title_slide_enabled: true  # Show title slide with image collage
slideshow_title_slide_duration: 15   # Title slide duration in seconds
```

**Recommended settings for competitions:**

- `slideshow_auto_reload_minutes: 5-15` for frequent leaderboard updates
- `default_slide_duration_seconds: 8-10` for good pacing
- `resume_session_timeout_seconds: 10-30` for unattended displays (0 = manual choice only)
- `slideshow_title_slide_enabled: true` for professional presentation
- `slideshow_title_slide_duration: 10-20` for title display timing
- Test with shorter intervals first, then extend for stability

