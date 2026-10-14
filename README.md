# Catalogue

A full-stack web app for organizing creative projects (characters, timelines, documents, canvas cards, and tasks) all in one place. Built for writers, worldbuilders, game designers, and anyone who manages complex creative work.

---

## What It Does

**For non-programmers:** Catalogue is a private workspace where you can build out entire fictional worlds or creative projects. Every project can have its own cast of characters (with personality profiles and images), a timeline of events, written documents, a canvas of connected note cards, and a task list synced with the Serenity productivity app. It connects to Serenity and Executor through a shared account system; log in once and your session works across all three.

**For programmers:** Node.js/Express monolith with EJS templating, MongoDB/Mongoose for storage, `express-session` + `connect-mongo` for SSO across the suite, and `bcrypt` for auth. All project data is stored as embedded subdocuments. The canvas is an SVG-based observable canvas with drag-to-connect wiring. Packaged as a cross-platform desktop app via Electron + electron-builder.

---

## Features

### Projects
- 13 categories: Novel, Short Story, Screenplay, Worldbuilding, Tabletop RPG, Game Design, Coding, Research, Art & Illustration, Music, Film & Video, Creative Writing, and custom
- Visibility: Private, Collaborators Only (share link grants edit), Unlisted (share link grants view), Public (listed on Explore)
- Invite collaborators by searching for existing users by name, email, or username; invited users receive an in-app notification and (for non-account holders) an invite email
- Shareable link tokens; public projects appear on the `/public` Explore page
- **Export:** download any project as Markdown ZIP, PDF, or EPUB (EPUB gated to Pro+)

### Characters
- Full profiles: name, nicknames, pronouns, role (Mention → Protagonist), description, traits, relationships
- Gallery images via file upload
- Radar-chart voice profile (6 axes: Formal–Casual, Verbose–Terse, etc.)
- Search bar with live filtering

### Timeline
- Visual and table views with BCE date support
- Events linked to characters
- Toggle between views without losing state

### Docs
- Collapsible doc list sidebar and section sidebar (collapse to 32px to maximize writing space)
- By-Section view: each section is an independently auto-saved block with word count, outline panel, and drag-to-reorder
- Whole-Doc view: assembled read-only view of all sections
- AJAX section creation, no page reload
- Research canvas: SVG drag-to-connect cards alongside documents, importable into sections
- Version history per section with one-click restore

### Cards (Canvas)
- Drag-to-connect: grab the ⬤ dot on any card and drag to another to wire them
- Click-to-connect also supported
- 6 connection endpoint symbols: arrow, filled-arrow, dot, circle, diamond, rectangle
- Separate start/end symbol pickers per connection
- Connections editable after saving: single-click → small Edit/Remove popup; double-click → full panel
- Card categories: Plot, Character, Theme, Setting, and custom
- AJAX card creation: cards appear instantly without page reload

### Task Manager
- Tasks assigned from Serenity WorkSessions or created directly
- Inline subtask adding without opening the edit modal
- Priority levels: High, Normal, Low
- Mark complete / reopen / delete

### Notifications & Inbox
- Bell icon in nav shows unread count badge
- Inbox lists all notifications (collaborator invites, task assignments, project adds, messages)
- Mark individual or all notifications as read

### Plans & Billing (Stripe)
- **Free:** 100 MB storage
- **Pro:** 5 GB storage, EPUB export, custom profile username/URL
- **Studio:** 100 GB storage, all Pro features, Team Workspaces
- Storage enforced at upload time, and files are rejected if the plan limit would be exceeded
- Stripe Checkout for subscription upgrades; webhook handles plan activation/cancellation

### Team Workspaces *(Studio)*
- Create named workspaces with an optional description
- Invite members by email; invitees receive an in-app notification
- Link projects to a workspace by project ID
- Workspace detail shows member roster and linked projects

### Profile
- Change name, email, password, avatar
- Custom username/profile URL (Pro+ only)
- Storage usage bar showing current usage vs. plan limit
- Mass export: download all projects as a single ZIP in Markdown or EPUB format
- Account deletion removes all owned projects and the user record

### App Switcher
- Hamburger menu (☰) in every header opens an app grid
- Apps pulled from a shared `websites` MongoDB collection with name, link, icon (Ionicons name), and color
- Favicon dynamically set from the site's own database entry

### Themes
- 17 color themes: Dark, Light, Retro, Pastel, Neon, Ocean, Solarized, Minimal, Autumn, Forest, Cyberpunk, Creamsicle, Dreamcore, Y2K, Celestial, Starry Neon, Pixel
- Theme synced across Catalogue, Serenity, and Executor via a shared cookie

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Database | MongoDB Atlas (Mongoose) |
| Templating | EJS (rendered via `fs.readFile` + `ejs.render`) |
| Auth | `express-session` + `bcrypt` + `connect-mongo` (7-day SSO) |
| File uploads | Multer |
| PDF export | PDFKit |
| EPUB / ZIP export | adm-zip |
| Payments | Stripe (Checkout, webhooks) |
| Email | Nodemailer (optional for collaborator invite emails) |
| Icons | Ionicons 7 (web components) |
| Date formatting | Moment.js |
| Charts | Chart.js (character voice radar) |
| Desktop packaging | Electron + electron-builder |
| CI/CD | GitHub Actions (Windows, macOS, Linux builds on tag push) |

---

## Local Setup

### Prerequisites
- Node.js 18+ (22.12+ to build desktop releases)
- A [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (free tier works)

### Steps

1. **Clone**
   ```bash
   git clone https://github.com/26SathvikV/Catalogue.git
   cd Catalogue
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create `.env`** in the project root (see [Environment Variables](#environment-variables) below):
   ```
   DATABASE=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<dbname>
   SESSION_SECRET=any_long_random_string
   ```

4. **Create the uploads directory**
   ```bash
   mkdir -p public/uploads
   ```

5. **Run**
   ```bash
   node index.js
   ```
   Open [http://localhost:4000](http://localhost:4000).

### Running as a Desktop App (Electron)
```bash
npm run electron
```

---

## Building Releases

Releases are built automatically by GitHub Actions on a version tag push:
```bash
git tag v1.0.0
git push --tags
```

This produces:
- `Catalogue-Windows-Setup.exe`: NSIS installer
- `Catalogue-macOS.dmg`: macOS disk image (x64 + arm64)
- `Catalogue-Linux.AppImage`: portable Linux binary

**Required GitHub Actions variable:** `CATALOGUE_URL`, the public HTTPS URL of the Railway-hosted Catalogue app. The desktop release opens this hosted app and does not bundle database credentials.
Optional signing secrets for Windows (`.pfx`) and macOS (Developer ID) are documented in the workflow file.

---

## Project Structure

```
Catalogue/
├── index.js                 # Express server, all routes, all Mongoose schemas
├── electron-main.js         # Electron entry point (starts Express, opens window)
├── package.json
├── .env                     # Not committed, see setup above
├── public/
│   ├── style.css
│   ├── uploads/             # User-uploaded images (gitignored)
│   └── res/                 # Default assets (flower icons, etc.)
└── views/
    ├── standard/
    │   ├── page.ejs          # Global layout (non-project pages)
    │   └── projectPage.ejs   # Project layout with tab nav
    ├── signup/
    │   ├── login.ejs
    │   └── signup.ejs
    └── pages/
        ├── index.ejs          # Home (stats, upcoming tasks, recent & public projects)
        ├── projects.ejs       # Project list
        ├── public.ejs         # Explore / public projects
        ├── addproject.ejs     # New project form
        ├── profile.ejs        # Profile, storage bar, mass export, account deletion
        ├── billing.ejs        # Plan comparison + Stripe Checkout trigger
        ├── inbox.ejs          # Notifications inbox
        ├── workspace.ejs      # Team Workspace list (Studio)
        ├── workspaceDetail.ejs # Workspace members + projects (Studio)
        └── projects/
            ├── index.ejs          # Project home (description, meta, export links)
            ├── characters.ejs     # Character gallery with search
            ├── character.ejs      # Character detail + voice chart
            ├── addCharacter.ejs   # Add/edit character form
            ├── timeline.ejs       # Timeline (visual + table views)
            ├── addEvent.ejs       # Add/edit event form
            ├── docs.ejs           # Section-based document editor + research canvas
            ├── cards.ejs          # SVG canvas with drag-to-connect cards
            ├── taskManager.ejs    # Task manager (Serenity integration)
            ├── relatedProjects.ejs
            └── settings.ejs       # Visibility, sharing, collaborator search + invite
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE` | YES | MongoDB connection URI |
| `SESSION_SECRET` | YES | Secret for signing session cookies |
| `SITE_URL` | Recommended | Full public URL (e.g. `https://catalogue.example.com`), used in SSO redirects and invite emails |
| `AUTH_HOST` | Optional | Base URL of the shared auth app, redirects login/signup there if set |
| `SSO_SECRET` | Optional | HMAC secret for verifying SSO tokens from `AUTH_HOST` |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth client secret |
| `STRIPE_SECRET_KEY` | Optional | Stripe secret key, enables billing/subscriptions |
| `STRIPE_PRICE_PRO` | Optional | Stripe Price ID for the Pro plan |
| `STRIPE_PRICE_STUDIO` | Optional | Stripe Price ID for the Studio plan |
| `STRIPE_WEBHOOK_SECRET` | Optional | Stripe webhook signing secret |
| `EMAIL_HOST` | Optional | SMTP host, enables collaborator invite emails |
| `EMAIL_PORT` | Optional | SMTP port (default: `587`) |
| `EMAIL_USER` | Optional | SMTP username / from address |
| `EMAIL_PASS` | Optional | SMTP password |
| `EMAIL_FROM` | Optional | From address for collaborator invitation emails; defaults to `EMAIL_USER` |
| `SIGNUPS_OPEN` | Optional | Set to `true` to allow new account creation. Omit or set to any other value to disable the signup page entirely (default: disabled). |
| `PORT` | Optional | HTTP port (default: `4000`) |

---

## Database Collections

All collections are on the same MongoDB Atlas cluster and shared across Catalogue, Serenity, and Executor:

| Collection | Used by |
|---|---|
| `users` | All three apps (shared accounts, includes `storageUsed` and `plan` fields) |
| `projects` | Catalogue |
| `cataloguenotifications` | Catalogue (inbox / bell badge) |
| `teamworkspaces` | Catalogue (Studio plan) |
| `worksessions` | Serenity (tasks linked into Catalogue) |
| `sessions` | All three apps (SSO session store) |
| `websites` | All three apps (app switcher grid) |

### `websites` collection schema
```json
{
  "site_name": "Catalogue",
  "link": "https://your-catalogue-url.com",
  "icon": "albums-outline",
  "color": "#FF66B3"
}
```
`icon` is an [Ionicons](https://ionic.io/ionicons) icon name. `color` is any CSS hex color.

### Cross-app notes
- `users.storageUsed` (Number, bytes) is incremented by Catalogue on every upload and enforced against plan limits. If Serenity or Executor also handle file uploads, they should increment this field to keep usage accurate.
- `cataloguenotifications` can be written to by other apps in the suite to surface cross-app notifications in Catalogue's inbox.

---

## Security Notes

- `.env` is gitignored, as you should never commit credentials
- MongoDB Atlas should have IP allowlisting enabled for production
- Sessions expire after 7 days; the session store uses MongoDB so restarts don't log users out
- Cookie consent is required before the color-scheme preference cookie is written
- Storage limits are enforced server-side at upload time (files deleted before DB write if limit exceeded)
- Account deletion removes all owned projects and the user record permanently
