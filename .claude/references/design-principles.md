# OmniEye — Updated Graphical Design Plan

## Core Product Concept

OmniEye should visually communicate one central idea:

> **The app predicts what the sky should look like, then traces the user's actual photo or video against that prediction to reconstruct what they were looking at.**

The 3D celestial model is the foundation.

The photo/video is observational evidence.

The final experience is the intersection of both.

```text
USER LOCATION + TIME
        ↓
ASTRONOMICAL PREDICTION
        ↓
3D CELESTIAL MODEL
        ↓
PHOTO / VIDEO
        ↓
SOURCE DETECTION + TRACKING
        ↓
ALIGNMENT / MATCHING
        ↓
OBSERVED CELESTIAL FIELD
        ↓
3D RECONSTRUCTION
```

Do not design the product as a conventional photo-analysis dashboard.

The user should feel like their photograph/video is being transformed into a **window through which OmniEye reconstructs the actual sky**.

---

# Three Fundamental Visual Layers

The entire visual system should revolve around three states.

## 1. Predicted Sky

What mathematics says should be there.

Generated from:

* Latitude
* Longitude
* UTC
* Observer elevation when available
* Camera orientation when available
* astronomy-engine
* HYG
* OpenNGC / Messier
* Constellation data

Visual language:

* Thin
* Precise
* Blue/violet
* Subtle
* Wireframe-like
* Scientific

Predicted objects should never visually imply that they were actually detected.

Example:

```text
○ Predicted star
◇ Predicted galaxy
```

---

# 2. Observed Sky

What OmniEye actually detects in the supplied media.

This includes:

* Stellar sources
* Bright points
* Persistent sources
* Moving sources
* Image features
* Potential astronomical objects

Visual language:

* Bright
* Slightly warmer
* Dynamic
* Traced
* Directly tied to the photograph/video

Example:

```text
● Observed source
```

The observed layer should visually originate from the image itself.

---

# 3. Matched Sky

Where predicted astronomy and observed evidence agree.

This is the most important state.

A matched object means:

> "OmniEye predicted this object here, detected something here, and determined that they correspond."

Visual language:

* Stronger glow
* Clean object marker
* Label
* Connection line between media and celestial object
* Confidence indicator

Example:

```text
◎ Matched object
```

Confidence should be represented separately.

```text
◎ M42
97.4% match
```

---

# The Main Experience

The main application should be organized around a giant interactive 3D sky.

Not around cards.

Not around forms.

Not around an upload dashboard.

The sky should occupy approximately 70–90% of the available visual space when possible.

Panels should appear around it.

---

# Default Observatory

When OmniEye starts without media:

```text
┌──────────────────────────────────────────────┐
│ OMNIEYE                         TIME   LOC.   │
│                                              │
│                 3D SKY                       │
│                                              │
│                    ✦                         │
│              ✦         ✦                    │
│                  ✦                           │
│       ─────────── horizon ───────────         │
│                                              │
│             N                               │
│                                              │
│                                    E         │
│                                              │
├──────────────────────────────────────────────┤
│ ALT 42.4°   AZ 137.2°   RA 05h35m   DEC...  │
└──────────────────────────────────────────────┘
```

The user can immediately explore the predicted sky.

This is Phase 0.

---

# Importing a Photograph

When the user imports a photograph, the application should transition into **Observation Reconstruction Mode**.

Do not simply open an image editor.

The UI should communicate:

```text
OBSERVATION IMPORTED

Reading metadata...
Locating observation...
Generating predicted sky...
Detecting stellar sources...
Aligning observed field...
```

The transition should feel like the instrument is beginning to reconstruct the observation.

---

# Photo + 3D Sky Relationship

The photograph should not simply sit beside the 3D scene.

The two should become spatially connected.

Preferred experience:

```text
                 3D SKY
                    │
                    │
             field-of-view
                 frustum
                    │
                    ▼
              ┌─────────┐
              │ PHOTO   │
              │         │
              │   ✦     │
              │     ✦   │
              │ ✦       │
              └─────────┘
```

The photograph represents the camera's field of view.

The 3D scene represents the entire celestial sphere.

The user should be able to understand:

> "This rectangle in the 3D sky is the exact portion of sky contained in my photograph."

---

# Field-of-View Visualization

Once focal length and image dimensions are available, visualize the camera's field of view.

The camera should become a frustum projected into the celestial sphere.

Example:

```text
                   STAR FIELD
          ✦        ✦       ✦
              ╲    │    ╱
               ╲   │   ╱
                ╲  │  ╱
                 ╲ │ ╱
                  ╲│╱
                   ●
                 CAMERA
```

The frustum should update as alignment changes.

---

# Automatic Tracing

The photo should be visually traced.

Detected stellar sources should produce markers directly over the photograph.

For example:

```text
             PHOTO

       ✦              ✦
            ◎
    ✦                    ✦
              ✦
```

The tracing layer should include:

* Source points
* Source brightness
* Detection confidence
* Matched object markers
* Constellation connections
* Deep-sky object regions
* Optional coordinate grid

The tracing should feel like scientific annotation rather than a computer-vision debugging interface.

---

# Matching Visualization

When OmniEye determines that an observed source corresponds to a predicted star:

```text
PHOTO                         SKY

    ● ------------------------ ◎
 observed                     matched
 source                       star
```

The connection should animate briefly when discovered.

Afterward it should become subtle.

Do not leave hundreds of bright connection lines visible permanently.

---

# Alignment State

Before alignment:

```text
PREDICTED
○   ○      ○
    ○
         ○

OBSERVED
●      ●
   ●
        ●
```

During alignment:

```text
PREDICTED
○──────○
   ╲
    ╲
     ●────●
       OBSERVED
```

After alignment:

```text
MATCHED
◎──────◎
  ◎
      ◎
◎──────◎
```

The transition should be visually obvious.

---

# Alignment Confidence

Show a compact instrument-style readout:

```text
FIELD ALIGNMENT

93.8%

18 / 21 sources matched

Rotation     +1.82°
Scale        1.004×
FOV          71.2°
```

Do not overwhelm the user with algorithmic details unless they enter a technical mode.

---

# Video Analysis

Video should be treated fundamentally differently from a still image.

Do not analyze every frame independently.

The interface should represent the video as a continuous observation.

```text
FRAME 01
   ↓
FRAME 02
   ↓
FRAME 03
   ↓
FRAME 04
   ↓
CAMERA PATH
```

As the camera moves, the traced field of view should move through the 3D celestial sphere.

---

# Camera Path

When processing video, visualize the camera trajectory.

Example:

```text
                 ✦
                  \
                   \     ✦
                    \
                     ●
                    /
                   /
             ●────●
            CAMERA PATH
```

The user should be able to replay the camera movement through the 3D sky.

This is one of OmniEye's signature visual features.

---

# Video Timeline

The timeline should correspond to both:

* Video time
* Celestial position

Example:

```text
00:00 ──── 00:05 ──── 00:10 ──── 00:15 ──── 00:20
  ●              ●          ●             ●
  │              │          │             │
  └────────────── CAMERA SKY PATH ─────────┘
```

Selecting a timeline position should move:

* Video frame
* Camera frustum
* 3D sky orientation
* Detected sources
* Matched objects

simultaneously.

---

# Moving Objects

The system should distinguish fixed celestial sources from moving objects.

Examples:

* Satellites
* Aircraft
* Potential meteors
* Camera artifacts

A moving source should generate a trajectory.

Example:

```text
✦
  ╲
   ╲
    ●
      ╲
       ●
        ╲
         ●
```

The UI should never automatically call something a satellite unless the astronomy logic supports that conclusion.

Use:

```text
POSSIBLE SATELLITE
POSSIBLE AIRCRAFT
UNRESOLVED MOVING SOURCE
```

when appropriate.

---

# 3D Reconstruction

After tracing succeeds, the user should be able to remove the photograph and see the reconstructed sky.

The application should smoothly transition:

```text
PHOTO
  ↓
PHOTO + TRACE
  ↓
TRACE + SKY
  ↓
3D RECONSTRUCTION
```

The photograph can fade into the background while the matched astronomical objects remain.

This should feel like the image is "turning into the sky."

---

# Observation Replay

Saved observations should be replayable.

A saved observation contains:

* Image/video
* Location
* Time
* Camera metadata
* Detected sources
* Matched objects
* Camera orientation
* Field of view
* Alignment
* Confidence
* Camera path for video

Opening it should reconstruct the observation exactly.

---

# Object Inspector

When an object is selected, show both sides of the evidence.

Example:

```text
ANDROMEDA GALAXY

M31 · Messier 31

OBSERVED
Detected in photograph

MATCH
96.7%

DISTANCE
2.54 million ly

ALTITUDE
31.8°

AZIMUTH
47.3°

FIELD POSITION
x: 64.2%
y: 37.8%
```

This is important.

The inspector should explicitly connect the astronomical object to the user's media.

---

# "Where Was This?" Mode

Selecting something in the photograph should locate it in the 3D sky.

User clicks a detected star:

```text
PHOTO
       ◎
       │
       │
       ▼
3D SKY

      ◎ Sirius
       │
       │
       ▼
AZ 184.2°
ALT 27.8°
```

This should work in reverse as well.

Selecting an object in the 3D sky should highlight its position in the photograph if it falls inside the observed field.

---

# "Where Is It Now?" Mode

This is the inverse interaction.

A user selects an object that was NOT in the original photograph.

OmniEye calculates where it is now.

Show:

```text
M31

NOT IN ORIGINAL FRAME

CURRENT POSITION

AZIMUTH
47.3°

ALTITUDE
31.8°

BEST VIEWING
22:41 – 03:12

[ NAVIGATE TO TARGET ]
```

Then rotate the 3D sky toward it.

This directly fulfills:

> "and a bearing to everything you weren't."

---

# Original vs Current Sky

Provide a visual toggle:

```text
OBSERVATION
CURRENT SKY
COMPARE
```

Observation:

```text
What the camera saw.
```

Current:

```text
Where everything is now.
```

Compare:

```text
What moved?
What remains?
What has risen?
What has set?
```

---

# Predicted vs Observed Toggle

Advanced users should be able to toggle:

```text
PREDICTED
OBSERVED
MATCHED
ALL
```

This is extremely useful for debugging and scientific transparency.

---

# Visual Legend

The interface should maintain a small contextual legend:

```text
○ Predicted
● Observed
◎ Matched
──── Constellation
╌╌ Camera path
↗ Target direction
```

The legend should appear only when relevant.

---

# Scientific Transparency

Never visually merge prediction and observation without communicating the distinction.

The application should always be able to answer:

> "Did OmniEye actually see this, or does it merely predict that it should be here?"

That distinction is fundamental to the product.

---

# Target Navigation

Target navigation should use the same celestial scene.

Selecting a target should:

1. Highlight the object.
2. Calculate current Alt/Az.
3. Rotate the scene toward it.
4. Show a bearing indicator.
5. Show altitude.
6. Show visibility.
7. Show rise/set information.
8. Show whether it was present in the original observation.

Example:

```text
M31

ORIGINAL OBSERVATION
Not observed

CURRENT SKY
Visible

AZ       47.3°
ALT      31.8°

BEST TIME
22:41

[ LOCK TARGET ]
```

---

# UI Modes

OmniEye should have distinct visual modes rather than displaying everything simultaneously.

## Observatory

Explore the predicted sky.

## Observation

Inspect a photo/video.

## Reconstruction

View predicted + observed + matched layers.

## Navigation

Find an astronomical target.

## Replay

Revisit a previous observation.

## Scientific

Expose technical data and coordinate systems.

The same underlying 3D scene should power all modes.

---

# Main Design Principle

Do not think:

```text
Dashboard
+
3D globe
+
Image analyzer
```

Think:

```text
                    OMNIEYE
                       │
                 CELESTIAL MODEL
                       │
              ┌────────┴────────┐
              │                 │
          PREDICTED          OBSERVED
              │                 │
              └────────┬────────┘
                       │
                    MATCHED
                       │
                 RECONSTRUCTED
                       │
            ┌──────────┴──────────┐
            │                     │
       WHAT YOU SAW          WHERE TO LOOK
```

The UI should make this relationship visually obvious.

---

# Animation Philosophy

Use animation to communicate astronomical relationships.

When a predicted star becomes matched:

```text
Predicted point
      ↓
Detected source
      ↓
Alignment
      ↓
◎ MATCHED
```

When a photo becomes aligned:

```text
PHOTO
 ↓
FIELD OF VIEW
 ↓
SKY
 ↓
RECONSTRUCTION
```

When navigating:

```text
CURRENT VIEW
      ↓
smooth camera rotation
      ↓
TARGET
      ↓
BEARING LOCKED
```

Animations should be smooth, restrained, and physically meaningful.

---

# Performance

Maintain the existing performance architecture.

The graphical layer must not compromise:

* 60+ FPS where hardware permits
* Single GPU star-field draw
* Web Workers for image analysis
* Minimal React re-renders
* Zustand selectors
* Cached catalog data
* Incremental video processing

Never render each detected star as an independent React DOM element.

Use:

* GPU buffers
* Three.js points
* Instancing where appropriate
* Canvas overlays only for small numbers of labels
* Workers for detection/tracking

---

# Final Product Feeling

The final application should feel like this:

> A user takes a photograph of the night sky.

> OmniEye looks at the photograph.

> It generates the sky that should have existed above that exact observer at that exact moment.

> It traces the stars and features actually visible in the photograph.

> It aligns the two.

> The photograph becomes a field of view inside a 3D celestial sphere.

> Stars become identified objects.

> The camera's movement becomes a path through the sky.

> The user can rotate around the reconstructed observation and understand exactly what they photographed.

> Then they can select something they did not photograph and ask:

> **"Where do I look to see it?"**

That is the visual identity of OmniEye.

The interface should make that transformation feel **magical, but mathematically grounded**.
