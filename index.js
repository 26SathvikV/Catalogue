require('dotenv').config();
const express = require('express');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const multer = require('multer');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { Schema } = mongoose;
const site_name = "Catalogue";
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mammoth = require('mammoth');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

// ─── Stripe setup ─────────────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PRICES = { pro: process.env.STRIPE_PRICE_PRO, studio: process.env.STRIPE_PRICE_STUDIO };

// ─── Plan limits ──────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
    free:   { collaborators: 10, cards: 50,  snapshots: 5  },
    pro:    { collaborators: 20, cards: 500, snapshots: 50 },
    studio: { collaborators: Infinity, cards: Infinity, snapshots: Infinity }
};
function planLimits(user) {
    return PLAN_LIMITS[user?.plan] || PLAN_LIMITS.free;
}
const BILLING_URL = 'https://www.sathvik-vemulapalli.com/billing';

const app = express();
const PORT = process.env.PORT || 4000;
const db = process.env.DATABASE;

mongoose.connect(db)
.then(() => console.log('MongoDB connected successfully!'))
.catch(err => console.error('MongoDB connection error:', err));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'views')));

// Stripe webhook needs raw body, so skip express.json for that path
app.use((req, res, next) => {
    if (req.originalUrl === '/billing/webhook') return next();
    express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// ─── Stripe Webhook (must be before any body-parsing hits this route) ─────────
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(503).send('Billing not configured');
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
        return res.status(400).send('Webhook error: ' + e.message);
    }
    if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        await User.findByIdAndUpdate(s.metadata.userId, {
            plan: s.metadata.plan,
            stripeSubscriptionId: s.subscription,
            stripeCustomerId: s.customer
        });
    }
    if (event.type === 'customer.subscription.deleted') {
        await User.findOneAndUpdate(
            { stripeSubscriptionId: event.data.object.id },
            { plan: 'free', stripeSubscriptionId: null }
        );
    }
    res.json({ received: true });
});

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'public/uploads/'); },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname); }
});
const upload = multer({ storage: storage });

// Storage limits (bytes) per plan
const STORAGE_LIMITS = { free: 100 * 1024 * 1024, pro: 5 * 1024 * 1024 * 1024, studio: 100 * 1024 * 1024 * 1024 };
function storageLimit(user) { return STORAGE_LIMITS[user?.plan] || STORAGE_LIMITS.free; }

// Middleware: check + update storage after a successful file upload
async function trackStorage(req, res, next) {
    if (!req.file || !req.session?.userId) return next();
    const fileSize = req.file.size || 0;
    const user = await User.findById(req.session.userId).select('plan storageUsed');
    if (!user) return next();
    const limit = storageLimit(user);
    if ((user.storageUsed || 0) + fileSize > limit) {
        const fs2 = require('fs');
        fs2.unlink(req.file.path, () => {});
        req.file = null;
        const isAjax2 = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
        const mbUsed = Math.round((user.storageUsed || 0) / 1024 / 1024);
        const mbLimit = Math.round(limit / 1024 / 1024);
        const hideMonetization = await isMonetizationHidden();
        const msg = `Storage limit reached (${mbUsed} MB / ${mbLimit} MB).` + (hideMonetization ? '' : ' Upgrade your plan to upload more files.');
        if (isAjax2) return res.status(413).json({ error: msg });
        return res.status(413).send(msg);
    }
    await User.findByIdAndUpdate(req.session.userId, { $inc: { storageUsed: fileSize } });
    next();
}

// ─── Models ───────────────────────────────────────────────────────────────────

const User = mongoose.model('User', new Schema({
    name: String,
    username: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    password: String,
    googleId: String,
    avatar: String,
    bio: String,
    birthdate: Date,
    isAdult: { type: Boolean, default: false },
    plan: { type: String, enum: ['free','pro','studio'], default: 'free' },
    stripeCustomerId: String,
    stripeSubscriptionId: String,
    dev: { type: Boolean, default: false },
    followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    savedProjects: [{ type: Schema.Types.ObjectId, ref: 'Projects' }],
    storageUsed: { type: Number, default: 0 }
}));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: getPublicBaseUrl() + '/auth/google/callback'
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            let user = await User.findOne({ googleId: profile.id });
            if (!user) {
                user = await User.findOne({ email: profile.emails?.[0]?.value });
                if (user) { user.googleId = profile.id; await user.save(); }
                else {
                    user = await User.create({
                        name: profile.displayName,
                        email: profile.emails?.[0]?.value,
                        googleId: profile.id,
                        avatar: profile.photos?.[0]?.value
                    });
                }
            }
            await acceptPendingProjectInvites(user);
            done(null, user);
        } catch(e) { done(e); }
    }));
}
passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
    try { done(null, await User.findById(id)); } catch(e) { done(e); }
});

// ─── Notification model ───────────────────────────────────────────────────────
const Notification = mongoose.model('CatalogueNotification', new Schema({
    userId:     { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:       { type: String, enum: ['project_add', 'task_assign', 'collab_invite', 'message'], default: 'message' },
    message:    { type: String, required: true },
    read:       { type: Boolean, default: false },
    createdAt:  { type: Date, default: Date.now },
    projectId:  Schema.Types.ObjectId,
    fromUserId: Schema.Types.ObjectId,
    link:       String
}));

async function createNotification(userId, type, message, opts = {}) {
    try { await Notification.create({ userId, type, message, ...opts }); } catch(e) { console.error('Notification error:', e.message); }
}

// Serenity-compatible models (shared MongoDB cluster)
const SubTaskSchema = new Schema({
    name: String,
    done: { type: Boolean, default: false }
});

const WorkSession = mongoose.model('WorkSession', new Schema({
    userId: Schema.Types.ObjectId,
    name: String,
    date: Date,
    groupId: Schema.Types.ObjectId,
    tasks: [SubTaskSchema],
    completed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}));

const Group = mongoose.model('Group', new Schema({
    userId: Schema.Types.ObjectId,
    name: String,
    color: { type: String, default: '#FF80CC' }
}));

// Catalogue-specific schemas
const CharacterSchema = new Schema({
    name: String,
    nicknames: [{ nickname: String, type: String }],
    pronouns: [{ pronoun: String, type: String }],
    icon: String,
    role: String,
    description: String,
    gallery: [String],
    relationships: [{ name: String, relation: String, characterId: Schema.Types.ObjectId }],
    voiceGraph: { pitch: Number, tempo: Number, clarity: Number, loudness: Number },
    traits: [{ key: String, value: mongoose.Schema.Types.Mixed, type: String }]
});

const TimelineSchema = new Schema({
    title: String,
    description: String,
    date: Date,
    relatedCharacters: [{ name: String, characterId: Schema.Types.ObjectId }]
});

const DocSectionConnectionSchema = new Schema({
    targetId: { type: Schema.Types.ObjectId },
    color: { type: String, default: '#4a90d9' },
    width: { type: Number, default: 1.5 },
    lineStyle: { type: String, default: 'solid' },
    symbol: { type: String, default: 'none' },
    label: { type: String, default: '' }
}, { _id: false });

const DocSectionSchema = new Schema({
    title: String,
    outline: String,
    content: String,
    description: String,
    group: String,
    mediaUrl: String,
    refLink: String,
    position: { type: Number, default: 0 },
    connections: [DocSectionConnectionSchema],
    updatedAt: Date,
    versions: [{ content: String, outline: String, savedAt: { type: Date, default: Date.now }, savedBy: String }]
});

const DocumentSchema = new Schema({
    title: String,
    docType: { type: String, enum: ['doc', 'folder', 'file'], default: 'doc' },
    parentId: Schema.Types.ObjectId,
    icon: String,
    isResearch: { type: Boolean, default: false },
    notes: String,
    sections: [DocSectionSchema],
    // file-type fields
    fileUrl: String,
    fileName: String,
    fileSize: Number,
    mimeType: String,
    fileVersions: [{ url: String, name: String, size: Number, uploadedAt: { type: Date, default: Date.now } }],
    createdAt: { type: Date, default: Date.now }
});

const CardConnectionSchema = new Schema({
    targetId: Schema.Types.ObjectId,
    color: { type: String, default: '#4a90d9' },
    width: { type: Number, default: 1.5 },
    symbolStart: { type: String, default: 'none' },
    symbolEnd:   { type: String, default: 'none' },
    symbol:      { type: String, default: 'none' },
    lineStyle:   { type: String, default: 'solid' },
    note: String,
    label: { type: String, default: '' }
}, { _id: false });

const CardSchema = new Schema({
    title: String,
    description: String,
    content: String,
    group: String,
    referenceLink: String,
    mediaUrl: String,
    category: { type: String, enum: ['plot', 'character', 'theme', 'setting'] },
    color: String,
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    connections: [CardConnectionSchema],
    sourceRef: { refType: String, refId: Schema.Types.ObjectId }
});

const Projects = mongoose.model('Projects', new Schema({
    name: String,
    description: String,
    category: String,
    visibility: { type: String, enum: ['private', 'collaborators_only', 'unlisted', 'public'], default: 'private' },
    public: Boolean,
    owner: { type: Schema.Types.ObjectId, ref: 'User' },
    shared: [{
        person: { type: Schema.Types.ObjectId, ref: 'User' },
        permission: { type: String, enum: ['view', 'edit'], default: 'view' }
    }],
    shareToken: String,
    editorToken: String,
    group: String,
    tags: [String],
    pendingCollabs: [{
        email: String,
        permission: { type: String, default: 'view' },
        invitedAt: { type: Date, default: Date.now }
    }],
    lastUpdated: { type: Date, default: Date.now },
    characters: [CharacterSchema],
    timeline: [TimelineSchema],
    docs: [DocumentSchema],
    cards: [CardSchema],
    tasks: [{ type: Schema.Types.ObjectId }],   // WorkSession IDs
    serenityGroupId: Schema.Types.ObjectId,
    relatedProjects: [{ type: Schema.Types.ObjectId, ref: 'Projects' }],
    likes: { type: Number, default: 0 },
    likedBy: [{ type: Schema.Types.ObjectId }],
    color: { type: String, default: '' },
    publicEditable: { type: Boolean, default: false },
    activityLog: [{ userId: Schema.Types.ObjectId, userName: String, action: String, at: { type: Date, default: Date.now } }]
}));

const Website = mongoose.model('Website', new Schema({
    site_name: String,
    link: String,
    icon: String,
    color: String,
    order: { type: Number, default: 0 },
    visible: { type: Boolean, default: true },
    self: { type: Boolean, default: false },
    hide_monetization: { type: Boolean, default: false },
    beta_test: { type: Boolean, default: false }
}), 'websites');

// Suite-wide toggle: when Homepage's `self:true` doc has hide_monetization set,
// every app hides upsell/monetization UI (pricing links, Upgrade CTAs, plan badges'
// upgrade prompts, checkout entry points). Usage-limit ENFORCEMENT is unaffected, as
// this only controls whether the upsell text/links are shown.
async function isMonetizationHidden() {
    const homepageDoc = await Website.findOne({ self: true }).select('hide_monetization').lean();
    return !!(homepageDoc && homepageDoc.hide_monetization);
}

// ─── Session ──────────────────────────────────────────────────────────────────

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.DATABASE,
        collectionName: 'sessions',
        ttl: 7 * 24 * 60 * 60
    }),
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use('/uploads', express.static('public/uploads'));
app.use('/res', express.static('public/res'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseArrayField(field) {
    if (!field) return [];
    if (Array.isArray(field)) return field;
    if (typeof field === 'string') {
        try {
            const parsed = JSON.parse(field);
            if (Array.isArray(parsed)) return parsed;
        } catch { return field.split(',').map(f => f.trim()).filter(Boolean); }
    }
    return [];
}

function normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function exactEmailPattern(email) {
    return new RegExp('^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function getPublicBaseUrl(req) {
    const configuredUrl = process.env.SITE_URL?.trim();
    if (configuredUrl) return configuredUrl.replace(/\/+$/, '');

    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
    if (railwayDomain) return `https://${railwayDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

    return req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:4000';
}

async function acceptPendingProjectInvites(user) {
    const email = normalizeEmail(user?.email);
    if (!email) return;

    const pendingProjects = await Projects.find({ 'pendingCollabs.email': exactEmailPattern(email) });
    for (const project of pendingProjects) {
        const pending = project.pendingCollabs.find(invite => normalizeEmail(invite.email) === email);
        if (!pending) continue;

        if (!project.owner.equals(user._id) && !project.shared.some(member => member.person.equals(user._id))) {
            project.shared.push({ person: user._id, permission: pending.permission });
        }
        project.pendingCollabs = project.pendingCollabs.filter(invite => normalizeEmail(invite.email) !== email);
        await project.save();
    }
}

async function renderProjectPage(res, { pageName, project, projectId, context, title, pageDir }) {
    const dir = pageDir || 'views/pages/projects';
    const pageFile = path.join(__dirname, dir, `${pageName}.ejs`);
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        try {
            const content = await ejs.render(pageTemplate, context, { filename: pageFile });
            res.render('standard/projectPage', {
                name: title || pageName,
                projectName: project.name,
                projectId,
                body: content
            });
        } catch (e) {
            console.error('EJS render error:', e);
            res.status(500).send('Render error: ' + e.message);
        }
    });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    const allProjects = await Projects.find({
        $or: [{ owner: req.session.userId }, { 'shared.person': req.session.userId }]
    }).sort({ lastUpdated: -1 });
    const recentProjects = allProjects.slice(0, 6);
    const stats = {
        projects: allProjects.length,
        characters: allProjects.reduce((a, p) => a + (p.characters?.length || 0), 0),
        docs: allProjects.reduce((a, p) => a + (p.docs?.length || 0), 0),
        tasks: allProjects.reduce((a, p) => a + (p.tasks?.length || 0), 0)
    };
    const taskIds = allProjects.flatMap(p => p.tasks || []);
    const upcomingTasks = taskIds.length
        ? await WorkSession.find({ _id: { $in: taskIds }, completed: false }).limit(5)
        : [];
    const popularPublic = await Projects.find({ visibility: 'public' }).sort({ lastUpdated: -1 }).limit(6);
    const pageFile = path.join(__dirname, 'views/pages/index.ejs');
    fs.readFile(pageFile, 'utf8', async (err, pageTemplate) => {
        if (err) return render404Page(res);
        const content = await ejs.render(pageTemplate, { user, recentProjects, stats, upcomingTasks, popularPublic }, { filename: pageFile });
        res.render('standard/page', { name: 'Home', body: content });
    });
});

app.get('/api/websites', async (req, res) => {
    if (!req.session.userId) return res.status(401).json([]);
    const sites = await Website.find({ visible: { $ne: false } }).sort({ order: 1 });
    res.json(sites);
});

app.get('/api/self', async (req, res) => {
    const site = await Website.findOne({ site_name });
    const base = site
        ? { icon: site.icon || 'globe-outline', color: site.color || '#888888', site_name: site.site_name }
        : { icon: 'globe-outline', color: '#888888', site_name };
    if (req.session?.userId) {
        const u = await User.findById(req.session.userId).select('plan');
        base.plan = u?.plan || 'free';
    }
    res.json(base);
});

const SIGNUPS_OPEN = process.env.SIGNUPS_OPEN === 'true';

app.get('/signup', (req, res) => {
    if (process.env.AUTH_HOST) {
        const back = encodeURIComponent(getPublicBaseUrl(req) + '/auth/sso');
        const inviteEmail = normalizeEmail(req.query.email);
        const emailParam = isValidEmail(inviteEmail) ? `&email=${encodeURIComponent(inviteEmail)}` : '';
        return res.redirect(`${process.env.AUTH_HOST.replace(/\/$/, '')}/signup?redirect=${back}&app=catalogue${emailParam}`);
    }
    if (!SIGNUPS_OPEN) {
        return res.status(403).send('<div style="text-align:center;margin-top:80px;font-family:sans-serif;"><h2>Sign-ups are not available.</h2><p>This instance is invite-only. Please log in with your existing account.</p><p style="margin-top:16px;"><a href="/login">Log in</a></p></div>');
    }
    const inviteEmail = normalizeEmail(req.query.email);
    res.render('signup/signup.ejs', { inviteEmail: isValidEmail(inviteEmail) ? inviteEmail : '' });
});
app.get('/login', (req, res) => {
    if (process.env.AUTH_HOST) {
        const back = encodeURIComponent(getPublicBaseUrl(req) + '/auth/sso');
        return res.redirect(`${process.env.AUTH_HOST}/login?redirect=${back}&app=catalogue`);
    }
    res.render('signup/login.ejs');
});

// ─── SSO callback from home page ──────────────────────────────────────────────
app.get('/auth/sso', async (req, res) => {
    const { token } = req.query;
    if (!token || !process.env.SSO_SECRET) return res.redirect('/login?error=no_token');
    try {
        const [payload64, sig] = token.split('.');
        if (!payload64 || !sig) return res.redirect('/login?error=bad_token');
        const expected = crypto.createHmac('sha256', process.env.SSO_SECRET).update(payload64).digest('base64url');
        const actualSignature = Buffer.from(sig, 'utf8');
        const expectedSignature = Buffer.from(expected, 'utf8');
        if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
            return res.redirect('/login?error=bad_token');
        }
        const data = JSON.parse(Buffer.from(payload64, 'base64url').toString());
        if (Date.now() > data.exp) return res.redirect('/login?error=expired');
        const user = await User.findById(data.userId).select('_id email name');
        if (!user) return res.redirect('/login?error=invalid');
        await acceptPendingProjectInvites(user);
        req.session.userId = user._id.toString();
        req.session.userName = user.name || data.name;
        res.redirect('/');
    } catch(e) {
        res.redirect('/login?error=invalid');
    }
});

app.post('/signup', async (req, res) => {
    if (!SIGNUPS_OPEN) return res.status(403).send('Sign-ups are not available on this instance.');
    const { name, pass, passconf, birthdate } = req.body;
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return res.status(400).send('Enter a valid email address.');
    if (pass !== passconf) return res.status(400).send('Passwords do not match');
    try {
        const hash = await bcrypt.hash(pass, 10);
        const userData = { name, email, password: hash };
        if (birthdate) {
            userData.birthdate = new Date(birthdate);
            const age = (Date.now() - new Date(birthdate)) / (1000 * 60 * 60 * 24 * 365.25);
            userData.isAdult = age >= 18;
        }
        const newUser = await new User(userData).save();
        await acceptPendingProjectInvites(newUser);
        res.redirect('/login');
    } catch (error) {
        if (error.code === 11000) return res.status(409).send('An account with that email already exists.');
        console.error('Signup failed:', error.message);
        return res.status(500).send('Could not create account. Please try again.');
    }
});

app.post('/login', async (req, res) => {
    const { email, pass } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).send('No user found with that email');
    bcrypt.compare(pass, user.password, (err, isMatch) => {
        if (err) return res.status(500).send('Error comparing passwords');
        if (!isMatch) return res.status(400).send('Incorrect password');
        req.session.userId = user._id;
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ─── Public / Project List ────────────────────────────────────────────────────

app.get('/public', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const projects = await Projects.find({ visibility: 'public' }).populate('owner', 'name').sort({ likes: -1, lastUpdated: -1 });
    const currentUser = await User.findById(req.session.userId).lean();
    const savedIds = new Set((currentUser?.savedProjects || []).map(id => id.toString()));
    const pageFile = path.join(__dirname, 'views/pages/public.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return render404Page(res);
        const content = await ejs.render(t, { projects, user: req.session.userId, savedIds: [...savedIds] }, { filename: pageFile });
        res.render('standard/page', { name: 'Public Projects', body: content });
    });
});

// Like toggle (public projects)
app.post('/projects/:id/like', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const project = await Projects.findById(req.params.id);
    if (!project || project.visibility !== 'public') return res.status(404).json({ error: 'Not found' });
    const uid = req.session.userId.toString();
    const idx = project.likedBy.findIndex(id => id.toString() === uid);
    if (idx === -1) {
        project.likedBy.push(req.session.userId);
        project.likes = project.likedBy.length;
    } else {
        project.likedBy.splice(idx, 1);
        project.likes = project.likedBy.length;
    }
    await project.save();
    res.json({ likes: project.likes, liked: idx === -1 });
});

// Save/unsave toggle
app.post('/projects/:id/save', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const currentUser = await User.findById(req.session.userId);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const pid = req.params.id;
    const idx = currentUser.savedProjects.findIndex(id => id.toString() === pid);
    if (idx === -1) currentUser.savedProjects.push(pid);
    else currentUser.savedProjects.splice(idx, 1);
    await currentUser.save();
    res.json({ saved: idx === -1 });
});

app.get('/projects', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const projects = await Projects.find({
        $or: [{ owner: req.session.userId }, { 'shared.person': req.session.userId }]
    });
    const pageFile = path.join(__dirname, 'views/pages/projects.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return render404Page(res);
        const content = await ejs.render(t, { projects, user: req.session.userId }, { filename: pageFile });
        res.render('standard/page', { name: 'Projects', body: content });
    });
});

app.get('/projects/add', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const pageFile = path.join(__dirname, 'views/pages/addproject.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return render404Page(res);
        const content = await ejs.render(t, {}, { filename: pageFile });
        res.render('standard/page', { name: 'Add Project', body: content });
    });
});

app.post('/projects/add', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    let { name, description, category, custom, group, tags } = req.body;
    if (category === 'custom') category = custom;
    const tagsArr = tags ? tags.split(',').map(function(t){ return t.trim(); }).filter(Boolean) : [];
    try {
        const project = new Projects({ name, description, category, group: group || '', tags: tagsArr, lastUpdated: new Date(), owner: req.session.userId });
        const savedProject = await project.save();
        savedProject.shared.push({ person: req.session.userId, permission: 'edit' });

        // Create matching Serenity group
        const group = new Group({ userId: req.session.userId, name, color: '#FF80CC' });
        const savedGroup = await group.save();
        savedProject.serenityGroupId = savedGroup._id;

        await savedProject.save();
        res.redirect('/projects');
    } catch (err) {
        console.error('Error saving project:', err);
        res.status(500).send('Could not save project.');
    }
});

// ─── Sharing ─────────────────────────────────────────────────────────────────

app.post('/projects/:projectId/share', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { email, permission = 'view' } = req.body;
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Project not found');
    const isEditor = project.owner.equals(req.session.userId) ||
        project.shared.some(s => s.person.equals(req.session.userId) && s.permission === 'edit');
    if (!isEditor) return res.status(403).send('You do not have permission to share this project');
    const userToShare = await User.findOne({ email });
    if (!userToShare) return res.status(404).send('User not found');
    if (project.shared.some(s => s.person.equals(userToShare._id)))
        return res.status(400).send('Project already shared with this user');
    const owner = await User.findById(req.session.userId).select('plan');
    const limit = planLimits(owner).collaborators;
    if (project.shared.length >= limit) {
        const hideMonetization = await isMonetizationHidden();
        const limitMsg = `Your plan allows up to ${limit} collaborators.`;
        return res.status(403).send(hideMonetization ? limitMsg : `${limitMsg} Upgrade at ${BILLING_URL}`);
    }
    project.shared.push({ person: userToShare._id, permission });
    await project.save();
    res.redirect(`/projects/${projectId}`);
});

// ─── Profile ──────────────────────────────────────────────────────────────────

app.get('/profile', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');
    const pageFile = path.join(__dirname, 'views/pages/profile.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return render404Page(res);
        const monetizationHidden = await isMonetizationHidden();
        const content = await ejs.render(t, { user, monetizationHidden }, { filename: pageFile });
        res.render('standard/page', { name: 'Profile', body: content });
    });
});

app.post('/profile/update', async (req, res) => {
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
        const { username, bio, birthdate } = req.body;
        const update = {};
        if (username) update.username = username.toLowerCase().replace(/[^a-z0-9_]/g,'');
        if (bio !== undefined) update.bio = bio;
        if (birthdate) {
            update.birthdate = new Date(birthdate);
            const age = (Date.now() - new Date(birthdate)) / (1000*60*60*24*365.25);
            update.isAdult = age >= 18;
        }
        await User.findByIdAndUpdate(req.session.userId, update);
        return res.json({ ok: true });
    }
    if (!req.session.userId) return res.redirect('/login');
    const { name, email, username, bio, avatar, birthdate } = req.body;
    const update = { name, email };
    if (username) {
        const profileUser = await User.findById(req.session.userId).select('plan');
        if (['pro', 'studio'].includes(profileUser?.plan)) {
            update.username = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        }
    }
    if (bio !== undefined) update.bio = bio;
    if (avatar !== undefined) update.avatar = avatar;
    if (birthdate) {
        update.birthdate = new Date(birthdate);
        const age = (Date.now() - new Date(birthdate)) / (1000 * 60 * 60 * 24 * 365.25);
        update.isAdult = age >= 18;
    }
    await User.findByIdAndUpdate(req.session.userId, update);
    res.redirect('/profile');
});

app.post('/profile/password', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword) return res.status(400).send('New passwords do not match');
    const user = await User.findById(req.session.userId);
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).send('Current password is incorrect');
    const hash = await bcrypt.hash(newPassword, 10);
    await User.findByIdAndUpdate(req.session.userId, { password: hash });
    res.redirect('/profile');
});

app.post('/profile/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const userId = req.session.userId;
    await Projects.deleteMany({ owner: userId });
    await User.findByIdAndDelete(userId);
    req.session.destroy(() => res.redirect('/login'));
});

// ─── Join via share link ──────────────────────────────────────────────────────

app.get('/join/:token', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { token } = req.params;
    let project = await Projects.findOne({ shareToken: token });
    let permission = 'view';
    if (!project) {
        project = await Projects.findOne({ editorToken: token });
        permission = 'edit';
    }
    if (!project) return res.status(404).send('Invalid or expired link');
    const alreadyMember = project.shared.some(s => s.person.equals(req.session.userId)) || project.owner.equals(req.session.userId);
    if (!alreadyMember) {
        project.shared.push({ person: req.session.userId, permission });
        await project.save();
    }
    res.redirect(`/projects/${project._id}`);
});

app.get('/billing', (req, res) => {
    res.redirect(BILLING_URL);
});

// ─── Single-segment catch-all (must be before project routes) ─────────────────

app.get('/:page', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const pageName = req.params.page;
    const pageFile = path.join(__dirname, 'views/pages', `${pageName}.ejs`);
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return render404Page(res);
        const content = await ejs.render(t, {}, { filename: pageFile });
        res.render('standard/page', { name: pageName, body: content });
    });
});

// ─── Project Home ─────────────────────────────────────────────────────────────

app.get('/projects/:projectId/', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    await renderProjectPage(res, { pageName: 'index', project, projectId, context: { project, projectId }, title: 'Home' });
});

// ─── Characters ───────────────────────────────────────────────────────────────

app.get('/projects/:projectId/characters', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    await renderProjectPage(res, { pageName: 'characters', project, projectId, context: { project, characters: project.characters }, title: 'Characters' });
});

app.get('/projects/:projectId/addCharacter', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    const flowerImages = fs.readdirSync(path.join(__dirname, 'public/res/flowers'));
    await renderProjectPage(res, {
        pageName: 'addcharacter', project, projectId,
        context: { projectId, flowerOptions: flowerImages },
        title: 'Add Character'
    });
});

app.post('/projects/:projectId/addCharacter', upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'gallery', maxCount: 10 }]), async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
        let { name, role, description, flowerIcon, voiceGraph = {}, traits = [] } = req.body;
        const { projectId } = req.params;
        const roleMap = ['Mention','Cameo','Background Character','Minor Character','Supporting Character','Side Character','Narrative Catalyst','Foil','Antagonist','Deuteragonist','Protagonist'];
        role = roleMap[parseInt(role)] || 'Unknown';
        const parsedVoiceGraph = {
            pitch: parseInt(voiceGraph.pitch || 5),
            tempo: parseInt(voiceGraph.tempo || 5),
            clarity: parseInt(voiceGraph.clarity || 5),
            loudness: parseInt(voiceGraph.loudness || 5)
        };
        let logoPath = flowerIcon || '';
        if (req.files?.['logo']) logoPath = '/uploads/' + req.files['logo'][0].filename;
        const formattedTraits = Array.isArray(traits) ? traits
            : Object.keys(traits).map(k => ({ key: traits[k]?.key, value: traits[k]?.value, type: traits[k]?.type }));
        const project = await Projects.findById(projectId);
        project.characters.push({ name, role, description, icon: logoPath, voiceGraph: parsedVoiceGraph, traits: formattedTraits });
        project.lastUpdated = new Date();
        await project.save();
        res.redirect(`/projects/${projectId}/characters`);
    } catch (e) { console.error(e); res.status(500).send('Error adding character.'); }
});

app.get('/projects/:projectId/characters/:characterId', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, characterId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    const character = project.characters.id(characterId);
    if (!character) return render404Page(res);
    await renderProjectPage(res, { pageName: 'character', project, projectId, context: { project, character, projectId }, title: character.name });
});

app.get('/projects/:projectId/characters/:characterId/edit', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, characterId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    const character = project.characters.id(characterId);
    if (!character) return render404Page(res);
    const flowerImages = fs.readdirSync(path.join(__dirname, 'public/res/flowers'));
    const roleMap = ['Mention','Cameo','Background Character','Minor Character','Supporting Character','Side Character','Narrative Catalyst','Foil','Antagonist','Deuteragonist','Protagonist'];
    await renderProjectPage(res, { pageName: 'addcharacter', project, projectId, context: { projectId, character, flowerOptions: flowerImages, roleMap }, title: 'Edit Character' });
});

app.post('/projects/:projectId/characters/:characterId', upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'gallery', maxCount: 10 }]), async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
        const { projectId, characterId } = req.params;
        const project = await Projects.findById(projectId);
        if (!project) return render404Page(res);
        const character = project.characters.id(characterId);
        if (!character) return render404Page(res);
        let { name, role, description, flowerIcon, voiceGraph = {}, traits = [] } = req.body;
        const roleMap = ['Mention','Cameo','Background Character','Minor Character','Supporting Character','Side Character','Narrative Catalyst','Foil','Antagonist','Deuteragonist','Protagonist'];
        role = roleMap[parseInt(role)] || 'Unknown';
        const parsedVoiceGraph = { pitch: parseInt(voiceGraph.pitch || 5), tempo: parseInt(voiceGraph.tempo || 5), clarity: parseInt(voiceGraph.clarity || 5), loudness: parseInt(voiceGraph.loudness || 5) };
        let logoPath = flowerIcon || character.icon;
        if (req.files) {
            if (req.files['logo']?.[0]) logoPath = '/uploads/' + req.files['logo'][0].filename;
            const gal = req.files['gallery']?.map(f => '/uploads/' + f.filename);
            if (gal?.length) character.gallery = gal;
        }
        const formattedTraits = parseArrayField(traits).map(t => ({ key: t.key, value: t.value, type: t.type || 'string' })).filter(t => t.key && t.value);
        character.name = name;
        character.role = role;
        character.description = description;
        character.icon = logoPath;
        character.voiceGraph = parsedVoiceGraph;
        character.traits = formattedTraits;
        character.nicknames = parseArrayField(req.body.nicknames);
        character.pronouns = parseArrayField(req.body.pronouns);
        project.lastUpdated = new Date();
        await project.save();
        res.redirect(`/projects/${projectId}/characters`);
    } catch (e) { console.error(e); res.status(500).send('Error updating character.'); }
});

app.get('/projects/:projectId/characters/:characterId/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, characterId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    project.characters.pull({ _id: characterId });
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/characters`);
});

// ─── Timeline ─────────────────────────────────────────────────────────────────

app.get('/projects/:projectId/timeline', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    await renderProjectPage(res, { pageName: 'timeline', project, projectId, context: { projectId, timeline: project.timeline }, title: 'Timeline' });
});

app.get('/projects/:projectId/timeline/add', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    await renderProjectPage(res, { pageName: 'addEvent', project, projectId, context: { projectId, characters: project.characters, event: null }, title: 'Add Event' });
});

app.post('/projects/:projectId/timeline', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { title, description, year, month, day, time, relatedCharacters } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Project not found');
    const parsedYear = parseInt(year, 10);
    const utcDate = new Date(Date.UTC(Math.abs(parsedYear), parseInt(month, 10), parseInt(day, 10), ...((time || '00:00').split(':').map(Number))));
    if (parsedYear < 0) utcDate.setUTCFullYear(parsedYear);
    const chars = Array.isArray(relatedCharacters) ? relatedCharacters : relatedCharacters ? [relatedCharacters] : [];
    const relatedCharactersArr = chars.map(id => { const c = project.characters.id(id); return c ? { name: c.name, characterId: c._id } : null; }).filter(Boolean);
    project.timeline.push({ title, description, date: utcDate, relatedCharacters: relatedCharactersArr });
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/timeline`);
});

app.get('/projects/:projectId/timeline/:eventId/edit', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, eventId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    const event = project.timeline.id(eventId);
    if (!event) return render404Page(res);
    await renderProjectPage(res, { pageName: 'addEvent', project, projectId, context: { projectId, characters: project.characters, event }, title: 'Edit Event' });
});

app.post('/projects/:projectId/timeline/:eventId/edit', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, eventId } = req.params;
    const { title, description, year, month, day, time, relatedCharacters } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Project not found');
    const event = project.timeline.id(eventId);
    if (!event) return res.status(404).send('Event not found');
    const parsedYear = parseInt(year, 10);
    const utcDate = new Date(Date.UTC(Math.abs(parsedYear), parseInt(month, 10), parseInt(day, 10), ...((time || '00:00').split(':').map(Number))));
    if (parsedYear < 0) utcDate.setUTCFullYear(parsedYear);
    const chars = Array.isArray(relatedCharacters) ? relatedCharacters : relatedCharacters ? [relatedCharacters] : [];
    event.title = title;
    event.description = description;
    event.date = utcDate;
    event.relatedCharacters = chars.map(id => { const c = project.characters.id(id); return c ? { name: c.name, characterId: c._id } : null; }).filter(Boolean);
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/timeline`);
});

// ─── Docs ─────────────────────────────────────────────────────────────────────

app.get('/projects/:projectId/docs', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId).populate('relatedProjects');
    if (!project) return render404Page(res);

    // Build cross-project doc list for references panel
    const relatedDocs = project.relatedProjects.flatMap(rp =>
        (rp.docs || []).map(d => ({ docId: d._id, docTitle: d.title, projectName: rp.name, projectId: rp._id, isResearch: d.isResearch }))
    );

    await renderProjectPage(res, {
        pageName: 'docs', project, projectId,
        context: { projectId, docs: project.docs, relatedDocs },
        title: 'Docs'
    });
});

// ─── File type icon helper ────────────────────────────────────────────────────
function fileTypeIcon(mimeType, fileName) {
    if (mimeType) {
        if (mimeType.startsWith('image/')) return 'image-outline';
        if (mimeType.startsWith('video/')) return 'film-outline';
        if (mimeType.startsWith('audio/')) return 'musical-notes-outline';
        if (mimeType === 'application/pdf') return 'document-outline';
        if (mimeType.includes('word') || mimeType.includes('officedocument.wordprocessingml')) return 'document-text-outline';
        if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv') return 'grid-outline';
        if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'easel-outline';
        if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed') || mimeType.includes('tar')) return 'archive-outline';
        if (mimeType.startsWith('text/')) return 'document-text-outline';
    }
    if (fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        const extMap = { jpg:'image-outline', jpeg:'image-outline', png:'image-outline', gif:'image-outline', svg:'image-outline', webp:'image-outline', bmp:'image-outline', mp4:'film-outline', mov:'film-outline', avi:'film-outline', webm:'film-outline', mkv:'film-outline', mp3:'musical-notes-outline', wav:'musical-notes-outline', ogg:'musical-notes-outline', flac:'musical-notes-outline', aac:'musical-notes-outline', pdf:'document-outline', docx:'document-text-outline', doc:'document-text-outline', md:'code-slash-outline', markdown:'code-slash-outline', txt:'document-text-outline', zip:'archive-outline', rar:'archive-outline', tar:'archive-outline', gz:'archive-outline', '7z':'archive-outline', psd:'easel-outline', ai:'easel-outline', sketch:'easel-outline', fig:'easel-outline', xlsx:'grid-outline', xls:'grid-outline', csv:'grid-outline', pptx:'easel-outline', ppt:'easel-outline' };
        return extMap[ext] || 'attach-outline';
    }
    return 'attach-outline';
}

// Create new document or folder
app.post('/projects/:projectId/docs', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { title, isResearch, docType, parentId } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Project not found');
    const newDoc = { title: title || (docType === 'folder' ? 'New Folder' : 'Untitled'), docType: docType || 'doc', isResearch: isResearch === 'true', sections: [] };
    if (parentId) newDoc.parentId = parentId;
    project.docs.push(newDoc);
    project.lastUpdated = new Date();
    await project.save();
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjax) {
        const created = project.docs[project.docs.length - 1];
        return res.json({ ok: true, doc: { _id: created._id, title: created.title, docType: created.docType, parentId: created.parentId || null } });
    }
    res.redirect(`/projects/${projectId}/docs`);
});

// Upload file as a new doc
app.post('/projects/:projectId/docs/upload-file', upload.single('file'), trackStorage, async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId } = req.params;
    const { parentId } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const fileUrl = '/uploads/' + req.file.filename;
    const mimeType = req.file.mimetype;
    const fileName = req.file.originalname;
    const fileSize = req.file.size;
    const title = req.body.title || fileName;
    const newDoc = { title, docType: 'file', icon: fileTypeIcon(mimeType, fileName), fileUrl, fileName, fileSize, mimeType, sections: [] };
    if (parentId) newDoc.parentId = parentId;
    project.docs.push(newDoc);
    project.lastUpdated = new Date();
    await project.save();
    const created = project.docs[project.docs.length - 1];
    res.json({ ok: true, doc: { _id: created._id, title: created.title, docType: 'file', parentId: created.parentId || null, icon: created.icon, fileUrl, fileName, mimeType, fileSize } });
});

// Upload new version of a file doc
app.post('/projects/:projectId/docs/:docId/upload-version', upload.single('file'), trackStorage, async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const doc = project.docs.id(docId);
    if (!doc) return res.status(404).json({ error: 'Doc not found' });
    // Push current version to history
    if (doc.fileUrl) {
        doc.fileVersions.push({ url: doc.fileUrl, name: doc.fileName || 'Previous version', size: doc.fileSize || 0 });
    }
    doc.fileUrl = '/uploads/' + req.file.filename;
    doc.fileName = req.file.originalname;
    doc.fileSize = req.file.size;
    doc.mimeType = req.file.mimetype;
    doc.icon = doc.icon || fileTypeIcon(doc.mimeType, doc.fileName);
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true, fileUrl: doc.fileUrl, fileName: doc.fileName, mimeType: doc.mimeType });
});

// Set custom icon for a doc
app.post('/projects/:projectId/docs/:docId/icon', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId } = req.params;
    const { icon } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const doc = project.docs.id(docId);
    if (!doc) return res.status(404).json({ error: 'Doc not found' });
    doc.icon = icon;
    await project.save();
    res.json({ ok: true });
});

// Convert file doc to Catalogue doc (md, docx, pdf)
app.post('/projects/:projectId/docs/:docId/convert', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const doc = project.docs.id(docId);
    if (!doc || doc.docType !== 'file') return res.status(400).json({ error: 'Not a file doc' });
    const filePath = require('path').join(__dirname, 'public', doc.fileUrl);
    let text = '';
    try {
        const ext = (doc.fileName || '').split('.').pop().toLowerCase();
        if (ext === 'md' || ext === 'txt' || doc.mimeType?.startsWith('text/')) {
            text = require('fs').readFileSync(filePath, 'utf8');
        } else if (ext === 'docx' || doc.mimeType?.includes('wordprocessingml')) {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            text = result.value;
        } else if (ext === 'pdf' || doc.mimeType === 'application/pdf') {
            try {
                const pdfParse = require('pdf-parse');
                const dataBuffer = require('fs').readFileSync(filePath);
                const data = await pdfParse(dataBuffer);
                text = data.text;
            } catch (e) { return res.status(400).json({ error: 'PDF parsing failed. Try a text-based PDF.' }); }
        } else {
            return res.status(400).json({ error: 'Cannot convert this file type' });
        }
    } catch (e) { return res.status(500).json({ error: 'Failed to read file: ' + e.message }); }
    // Split into paragraphs for sections
    const paragraphs = text.split(/\n{2,}/).map(function(p) { return p.trim(); }).filter(Boolean);
    const sections = paragraphs.length > 0
        ? paragraphs.map(function(p, i) { return { title: 'Section ' + (i + 1), content: p, position: i }; })
        : [{ title: 'Content', content: text.trim(), position: 0 }];
    doc.docType = 'doc';
    doc.sections = sections;
    doc.isResearch = false;
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true, docId, sections: sections.map(function(s) { return { _id: s._id, title: s.title, content: s.content }; }) });
});

// Delete document
app.post('/projects/:projectId/docs/:docId/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, docId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Project not found');
    project.docs.pull({ _id: docId });
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/docs`);
});

// Rename document (AJAX)
app.post('/projects/:projectId/docs/:docId/rename', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId } = req.params;
    const { title } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const doc = project.docs.id(docId);
    if (!doc) return res.status(404).json({ error: 'Doc not found' });
    doc.title = title;
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Save per-doc notes (AJAX)
app.post('/projects/:projectId/docs/:docId/notes', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId } = req.params;
    const { notes } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const doc = project.docs.id(docId);
    if (!doc) return res.status(404).json({ error: 'Doc not found' });
    doc.notes = notes;
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Add section to document
app.post('/projects/:projectId/docs/:docId/sections', upload.single('media'), trackStorage, async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, docId } = req.params;
    const { title, description, group, content, refLink } = req.body;
    const mediaUrl = req.file ? '/uploads/' + req.file.filename : '';
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Project not found');
    const doc = project.docs.id(docId);
    if (!doc) return res.status(404).send('Doc not found');
    doc.sections.push({ title: title || 'New Section', description: description || '', group: group || '', outline: '', content: content || '', refLink: refLink || '', mediaUrl: mediaUrl, position: doc.sections.length });
    project.lastUpdated = new Date();
    await project.save();
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjax) {
        const newSec = doc.sections[doc.sections.length - 1];
        return res.json({ ok: true, section: { _id: newSec._id, title: newSec.title, description: newSec.description, group: newSec.group, content: newSec.content, refLink: newSec.refLink, mediaUrl: newSec.mediaUrl } });
    }
    res.redirect(`/projects/${projectId}/docs`);
});

// Save section outline (AJAX)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/outline', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { outline } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    section.outline = outline;
    section.updatedAt = new Date();
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Save section content (AJAX)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/save', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { content } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    section.content = content;
    section.updatedAt = new Date();
    project.lastUpdated = new Date();
    // Version snapshot (capped by plan)
    const snapUser = await User.findById(req.session.userId).select('plan');
    const snapLimit = planLimits(snapUser).snapshots;
    section.versions = section.versions || [];
    section.versions.push({ content: content, savedAt: new Date(), savedBy: req.session.userName || 'Unknown' });
    if (section.versions.length > snapLimit) section.versions = section.versions.slice(-snapLimit);
    // Activity log
    project.activityLog = project.activityLog || [];
    project.activityLog.push({ userId: req.session.userId, userName: req.session.userName || 'Unknown', action: 'Edited "' + section.title + '"', at: new Date() });
    if (project.activityLog.length > 200) project.activityLog = project.activityLog.slice(-200);
    await project.save();
    res.json({ ok: true });
});

// Delete section
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, docId, sectionId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    const doc = project.docs.id(docId);
    if (!doc) return res.status(404).send('Doc not found');
    doc.sections.pull({ _id: sectionId });
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/docs`);
});

// Update research section metadata (AJAX)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/meta', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { description, group, refLink, title, content } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    if (title       !== undefined) section.title       = title;
    if (description !== undefined) section.description = description;
    if (group       !== undefined) section.group       = group;
    if (refLink     !== undefined) section.refLink     = refLink;
    if (content     !== undefined) section.content     = content;
    section.updatedAt = new Date();
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Upload media for research section
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/media', upload.single('media'), trackStorage, async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, docId, sectionId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).send('Section not found');
    if (req.file) section.mediaUrl = '/uploads/' + req.file.filename;
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/docs`);
});

// Connect sections in research doc (AJAX)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/connect', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { targetSectionId } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    if (!section.connections.find(c => c.targetId && c.targetId.toString() === targetSectionId)) {
        section.connections.push({ targetId: targetSectionId });
    }
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Disconnect sections (AJAX)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/disconnect', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { targetSectionId } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    section.connections = section.connections.filter(c => !c.targetId || c.targetId.toString() !== targetSectionId);
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Update research section connection properties (color, width, lineStyle, label)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/connection/:targetId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId, targetId } = req.params;
    const { color, width, lineStyle, symbol, label } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    const conn = section.connections.find(c => c.targetId && c.targetId.toString() === targetId);
    if (conn) {
        if (color     !== undefined) conn.color     = color;
        if (width     !== undefined) conn.width     = parseFloat(width);
        if (lineStyle !== undefined) conn.lineStyle = lineStyle;
        if (symbol    !== undefined) conn.symbol    = symbol;
        if (label     !== undefined) conn.label     = label;
    }
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Update section position (AJAX - for research doc drag)
app.post('/projects/:projectId/docs/:docId/sections/:sectionId/position', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { position } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const section = project.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    section.position = parseInt(position) || 0;
    await project.save();
    res.json({ ok: true });
});

// ─── Cards ────────────────────────────────────────────────────────────────────

app.get('/projects/:projectId/cards', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId).populate('relatedProjects');
    if (!project) return render404Page(res);

    // Gather source data for "create from existing" panel + cross-project
    const allChars = [...project.characters.map(c => ({ type: 'character', id: c._id, label: c.name, icon: c.icon, projectId, projectName: project.name }))];
    const allEvents = [...project.timeline.map(e => ({ type: 'event', id: e._id, label: e.title, projectId, projectName: project.name }))];
    const allSourceCards = [];
    for (const rp of project.relatedProjects) {
        rp.characters.forEach(c => allChars.push({ type: 'character', id: c._id, label: c.name, icon: c.icon, projectId: rp._id, projectName: rp.name }));
        rp.timeline.forEach(e => allEvents.push({ type: 'event', id: e._id, label: e.title, projectId: rp._id, projectName: rp.name }));
        rp.cards.forEach(c => allSourceCards.push({ id: c._id, label: c.title, category: c.category, projectId: rp._id, projectName: rp.name }));
    }

    // Populate WorkSessions for tasks
    const sessions = await WorkSession.find({ _id: { $in: project.tasks } });
    const allTasks = sessions.map(s => ({ type: 'task', id: s._id, label: s.name, projectId, projectName: project.name }));

    await renderProjectPage(res, {
        pageName: 'cards', project, projectId,
        context: { projectId, cards: project.cards, allChars, allEvents, allTasks, allSourceCards },
        title: 'Cards'
    });
});

app.post('/projects/:projectId/cards', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { title, description, content, group, referenceLink, mediaUrl, category, color, x, y } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    const cardOwner = await User.findById(req.session.userId).select('plan');
    const cardLimit = planLimits(cardOwner).cards;
    if ((project.cards?.length || 0) >= cardLimit) {
        const hideMonetization = await isMonetizationHidden();
        const limitMsg = `Your plan allows up to ${cardLimit} canvas cards per project.`;
        return res.status(403).send(hideMonetization ? limitMsg : `${limitMsg} Upgrade at ${BILLING_URL}`);
    }
    project.cards.push({ title, description, content, group, referenceLink, mediaUrl, category, color: color || '#888888', x: parseInt(x) || 0, y: parseInt(y) || 0 });
    project.lastUpdated = new Date();
    await project.save();
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjax) {
        const newCard = project.cards[project.cards.length - 1];
        return res.json({ ok: true, card: { _id: newCard._id, title: newCard.title, description: newCard.description, content: newCard.content, group: newCard.group, referenceLink: newCard.referenceLink, mediaUrl: newCard.mediaUrl, category: newCard.category, x: newCard.x, y: newCard.y } });
    }
    res.redirect(`/projects/${projectId}/cards`);
});

// Create card from existing item (character / event / task)
app.post('/projects/:projectId/cards/from/:refType/:refId', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, refType, refId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    const refOwner = await User.findById(req.session.userId).select('plan');
    if ((project.cards?.length || 0) >= planLimits(refOwner).cards) {
        const hideMonetization = await isMonetizationHidden();
        const limitMsg = `Canvas card limit reached for your plan.`;
        return res.status(403).send(hideMonetization ? limitMsg : `${limitMsg} Upgrade at ${BILLING_URL}`);
    }
    let title = '', content = '', category = 'plot';
    if (refType === 'character') {
        let char = project.characters.id(refId);
        if (!char) {
            const pop = await Projects.findById(projectId).populate('relatedProjects');
            for (const rp of pop.relatedProjects) { char = rp.characters.id(refId); if (char) break; }
        }
        if (char) { title = char.name; content = char.description || ''; category = 'character'; }
    } else if (refType === 'event') {
        let ev = project.timeline.id(refId);
        if (!ev) {
            const pop = await Projects.findById(projectId).populate('relatedProjects');
            for (const rp of pop.relatedProjects) { ev = rp.timeline.id(refId); if (ev) break; }
        }
        if (ev) { title = ev.title; content = ev.description || ''; category = 'plot'; }
    } else if (refType === 'task') {
        const session = await WorkSession.findById(refId);
        if (session) { title = session.name; content = ''; category = 'plot'; }
    }
    project.cards.push({ title, content, category, color: '#888888', x: 0, y: 0, sourceRef: { refType, refId } });
    project.lastUpdated = new Date();
    await project.save();
    const isAjaxRef = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjaxRef) {
        const newCard = project.cards[project.cards.length - 1];
        return res.json({ ok: true, card: { _id: newCard._id, title: newCard.title, description: newCard.description, content: newCard.content, group: newCard.group, referenceLink: newCard.referenceLink, mediaUrl: newCard.mediaUrl, category: newCard.category, x: newCard.x, y: newCard.y } });
    }
    res.redirect(`/projects/${projectId}/cards`);
});

// Create card from existing canvas card (related projects)
app.post('/projects/:projectId/cards/from/card/:sourceCardId', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, sourceCardId } = req.params;
    const project = await Projects.findById(projectId).populate('relatedProjects');
    if (!project) return res.status(404).send('Not found');
    const srcOwner = await User.findById(req.session.userId).select('plan');
    if ((project.cards?.length || 0) >= planLimits(srcOwner).cards) {
        const hideMonetization = await isMonetizationHidden();
        const limitMsg = `Canvas card limit reached for your plan.`;
        return res.status(403).send(hideMonetization ? limitMsg : `${limitMsg} Upgrade at ${BILLING_URL}`);
    }
    let srcCard = null;
    for (const rp of project.relatedProjects) {
        srcCard = rp.cards.id(sourceCardId);
        if (srcCard) break;
    }
    if (!srcCard) return res.status(404).send('Source card not found');
    project.cards.push({
        title: srcCard.title, description: srcCard.description, content: srcCard.content,
        group: srcCard.group, referenceLink: srcCard.referenceLink, mediaUrl: srcCard.mediaUrl,
        category: srcCard.category || 'plot', color: '#888888', x: 60, y: 60
    });
    project.lastUpdated = new Date();
    await project.save();
    const isAjaxSrc = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
    if (isAjaxSrc) {
        const newCard = project.cards[project.cards.length - 1];
        return res.json({ ok: true, card: { _id: newCard._id, title: newCard.title, description: newCard.description, content: newCard.content, group: newCard.group, referenceLink: newCard.referenceLink, mediaUrl: newCard.mediaUrl, category: newCard.category, x: newCard.x, y: newCard.y } });
    }
    res.redirect(`/projects/${projectId}/cards`);
});

// Add connection (AJAX)
app.post('/projects/:projectId/cards/:cardId/connect', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, cardId } = req.params;
    const { targetId, color = '#4a90d9', width = 1.5, symbolStart = 'none', symbolEnd = 'none', symbol = 'none', lineStyle = 'solid', note = '', label = '' } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const card = project.cards.id(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const existingIdx = card.connections.findIndex(c => c.targetId && c.targetId.toString() === targetId);
    if (existingIdx === -1) card.connections.push({ targetId, color, width, symbolStart, symbolEnd, symbol, lineStyle, note, label });
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true, connection: { targetId, color, width, symbolStart, symbolEnd, symbol, lineStyle, note, label } });
});

// Update connection properties (AJAX)
app.post('/projects/:projectId/cards/:cardId/connection/:targetId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, cardId, targetId } = req.params;
    const { color, width, symbolStart, symbolEnd, symbol, lineStyle, note, label } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const card = project.cards.id(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const conn = card.connections.find(c => c.targetId && c.targetId.toString() === targetId);
    if (conn) {
        if (color       !== undefined) conn.color       = color;
        if (width       !== undefined) conn.width       = parseFloat(width);
        if (symbolStart !== undefined) conn.symbolStart = symbolStart;
        if (symbolEnd   !== undefined) conn.symbolEnd   = symbolEnd;
        if (symbol      !== undefined) conn.symbol      = symbol;
        if (lineStyle   !== undefined) conn.lineStyle   = lineStyle;
        if (note        !== undefined) conn.note        = note;
        if (label       !== undefined) conn.label       = label;
    }
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

app.post('/projects/:projectId/cards/:cardId/disconnect', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, cardId } = req.params;
    const { targetId } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const card = project.cards.id(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    card.connections = card.connections.filter(c => c.targetId && c.targetId.toString() !== targetId);
    // Also disconnect reverse direction if present
    const target = project.cards.id(targetId);
    if (target) target.connections = target.connections.filter(c => c.targetId && c.targetId.toString() !== cardId);
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Move card (AJAX)
app.post('/projects/:projectId/cards/:cardId/move', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, cardId } = req.params;
    const { x, y } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const card = project.cards.id(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    card.x = parseInt(x) || 0;
    card.y = parseInt(y) || 0;
    await project.save();
    res.json({ ok: true });
});

app.post('/projects/:projectId/cards/:cardId/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, cardId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    project.cards.pull({ _id: cardId });
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/cards`);
});

app.post('/projects/:projectId/cards/:cardId/update', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { projectId, cardId } = req.params;
    const { title, description, category, content, group, referenceLink, mediaUrl } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const card = project.cards.id(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    if (title !== undefined) card.title = title;
    if (description !== undefined) card.description = description;
    if (category !== undefined) card.category = category;
    if (content !== undefined) card.content = content;
    if (group !== undefined) card.group = group;
    if (referenceLink !== undefined) card.referenceLink = referenceLink;
    if (mediaUrl !== undefined) card.mediaUrl = mediaUrl;
    project.lastUpdated = new Date();
    await project.save();
    res.json({ ok: true });
});

// Get single card data (for edit modal)
app.get('/projects/:projectId/cards/:cardId/data', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { projectId, cardId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const card = project.cards.id(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json({
        title: card.title, description: card.description, category: card.category,
        content: card.content, group: card.group, referenceLink: card.referenceLink, mediaUrl: card.mediaUrl
    });
});

// ─── Task Manager (Serenity WorkSession integration) ─────────────────────────

app.get('/projects/:projectId/taskManager', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);

    // Fetch linked WorkSessions
    const sessions = await WorkSession.find({ _id: { $in: project.tasks } });

    // Available sessions to assign (user's sessions not already linked)
    const available = await WorkSession.find({
        userId: req.session.userId,
        _id: { $nin: project.tasks }
    }).sort({ createdAt: -1 }).limit(50);

    await renderProjectPage(res, {
        pageName: 'taskManager', project, projectId,
        context: { projectId, sessions, available },
        title: 'Task Manager'
    });
});

// Create new task → creates a WorkSession in Serenity
app.post('/projects/:projectId/taskManager', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { name, description, priority } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');

    // Encode priority in name so it's visible in Serenity
    const priorityPrefix = priority === 'high' ? '[HIGH] ' : priority === 'low' ? '[LOW] ' : '';
    const sessionName = priorityPrefix + (name || 'Untitled Task');

    const session = new WorkSession({
        userId: req.session.userId,
        name: sessionName,
        groupId: project.serenityGroupId,
        tasks: description ? [{ name: description }] : [],
        completed: false
    });
    const saved = await session.save();

    project.tasks.push(saved._id);
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Edit task name/subtasks
app.post('/projects/:projectId/taskManager/:taskId/edit', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, taskId } = req.params;
    const { name, priority, subtasks } = req.body;

    const session = await WorkSession.findById(taskId);
    if (!session) return res.status(404).send('Task not found');

    const priorityPrefix = priority === 'high' ? '[HIGH] ' : priority === 'low' ? '[LOW] ' : '';
    const baseName = name.replace(/^\[(HIGH|LOW)\] /, '');
    session.name = priorityPrefix + baseName;

    if (subtasks) {
        const names = Array.isArray(subtasks) ? subtasks : [subtasks];
        session.tasks = names.filter(n => n.trim()).map(n => ({ name: n.trim(), done: false }));
    }

    await session.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Toggle task complete status
app.post('/projects/:projectId/taskManager/:taskId/status', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { taskId, projectId } = req.params;
    const { completed } = req.body;
    const session = await WorkSession.findById(taskId);
    if (!session) return res.status(404).send('Not found');
    session.completed = completed === 'true';
    await session.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Add subtask inline
app.post('/projects/:projectId/taskManager/:taskId/addsubtask', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, taskId } = req.params;
    const { subtask } = req.body;
    if (!subtask || !subtask.trim()) return res.redirect(`/projects/${projectId}/taskManager`);
    const session = await WorkSession.findById(taskId);
    if (!session) return res.status(404).send('Not found');
    session.tasks.push({ name: subtask.trim(), done: false });
    await session.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Toggle subtask done
app.post('/projects/:projectId/taskManager/:taskId/subtask/:subtaskId', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, taskId, subtaskId } = req.params;
    const { done } = req.body;
    const session = await WorkSession.findById(taskId);
    if (!session) return res.status(404).send('Not found');
    const sub = session.tasks.id(subtaskId);
    if (sub) sub.done = done === 'true';
    await session.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Assign an existing Serenity session to this project
app.post('/projects/:projectId/taskManager/assign', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { sessionId } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    if (!project.tasks.map(t => t.toString()).includes(sessionId)) {
        // Update the session's groupId to this project's group
        await WorkSession.findByIdAndUpdate(sessionId, { groupId: project.serenityGroupId });
        project.tasks.push(sessionId);
        project.lastUpdated = new Date();
        await project.save();
    }
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Unlink task from project (does NOT delete WorkSession)
app.post('/projects/:projectId/taskManager/:taskId/unlink', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, taskId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    project.tasks = project.tasks.filter(t => t.toString() !== taskId);
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// Delete task entirely (deletes WorkSession + unlinks)
app.post('/projects/:projectId/taskManager/:taskId/delete', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, taskId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    await WorkSession.findByIdAndDelete(taskId);
    project.tasks = project.tasks.filter(t => t.toString() !== taskId);
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/taskManager`);
});

// ─── Related Projects ─────────────────────────────────────────────────────────

app.get('/projects/:projectId/projects', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId).populate('relatedProjects');
    if (!project) return render404Page(res);
    const otherProjects = await Projects.find({ _id: { $nin: [projectId, ...project.relatedProjects.map(p => p._id)] } });
    await renderProjectPage(res, { pageName: 'relatedProjects', project, projectId, context: { project, otherProjects }, title: 'Projects' });
});

app.post('/projects/:projectId/projects/add', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { relatedProjectId } = req.body;
    if (!relatedProjectId) return res.redirect(`/projects/${projectId}/projects`);
    const project = await Projects.findById(projectId);
    const related = await Projects.findById(relatedProjectId);
    if (!project || !related) return res.status(404).send('Project not found');
    
    // Mutual attachment
    if (!project.relatedProjects.some(id => id.equals(related._id))) project.relatedProjects.push(related._id);
    if (!related.relatedProjects.some(id => id.equals(project._id))) related.relatedProjects.push(project._id);

    // Visibility escalation
    const visOrder = ['private', 'collaborators_only', 'unlisted', 'public'];
    const ai = visOrder.indexOf(project.visibility || 'private');
    const bi = visOrder.indexOf(related.visibility || 'private');
    const newVis = visOrder[Math.max(ai, bi)];
    project.visibility = newVis; project.public = newVis === 'public';
    related.visibility = newVis; related.public = newVis === 'public';
    await project.save();
    await related.save();
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ ok: true });
    }
    res.redirect(`/projects/${projectId}/projects`);
});

app.post('/projects/:projectId/projects/remove/:relatedId', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, relatedId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    project.relatedProjects = project.relatedProjects.filter(id => !id.equals(relatedId));
    await project.save();
    const related = await Projects.findById(relatedId);
    if (related) {
        related.relatedProjects = related.relatedProjects.filter(id => !id.equals(projectId));
        await related.save();
    }
    res.redirect(`/projects/${projectId}/projects`);
});

// Delete a project (owner only)
app.post('/projects/:projectId/delete', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const project = await Projects.findById(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!project.owner.equals(req.session.userId)) return res.status(403).json({ error: 'Forbidden' });
    await Projects.findByIdAndDelete(req.params.projectId);
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ ok: true });
    }
    res.redirect('/projects');
});

// ─── Project Settings ─────────────────────────────────────────────────────────

app.get('/projects/:projectId/settings', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId).populate('shared.person');
    if (!project) return render404Page(res);
    const isOwner = project.owner.equals(req.session.userId);
    if (!isOwner) return res.status(403).send('Only the project owner can access settings');
    await renderProjectPage(res, {
        pageName: 'settings', project, projectId,
        context: {
            project, projectId, isOwner,
            pendingCollabs: project.pendingCollabs || [],
            errorMsg: req.query.error || null,
            successMsg: req.query.success || null,
            siteOrigin: (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host')
        },
        title: 'Settings'
    });
});

app.post('/projects/:projectId/settings', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { name, description, category, visibility, group, tags, color, publicEditable } = req.body;
    const project = await Projects.findById(projectId);
    if (!project) return res.status(404).send('Not found');
    if (!project.owner.equals(req.session.userId)) return res.status(403).send('Forbidden');
    project.name = name || project.name;
    project.description = description;
    project.category = category;
    project.group = group !== undefined ? group : project.group;
    if (tags !== undefined) project.tags = tags.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
    project.visibility = visibility || 'private';
    project.public = visibility === 'public';
    if (color !== undefined) project.color = color;
    project.publicEditable = publicEditable === 'on';
    project.lastUpdated = new Date();
    await project.save();
    res.redirect(`/projects/${projectId}/settings`);
});

// Generate share link
app.post('/projects/:projectId/settings/sharelink', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project || !project.owner.equals(req.session.userId)) return res.status(403).send('Forbidden');
    const crypto = require('crypto');
    project.shareToken = crypto.randomBytes(16).toString('hex');
    project.editorToken = crypto.randomBytes(16).toString('hex');
    await project.save();
    res.redirect(`/projects/${projectId}/settings`);
});

// Remove collaborator
app.post('/projects/:projectId/settings/remove/:memberId', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, memberId } = req.params;
    const project = await Projects.findById(projectId);
    if (!project || !project.owner.equals(req.session.userId)) return res.status(403).send('Forbidden');
    project.shared = project.shared.filter(s => !s.person.equals(memberId));
    await project.save();
    res.redirect(`/projects/${projectId}/settings`);
});

// Invite collaborator by email
app.post('/projects/:projectId/settings/invite', async (req, res) => {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['content-type']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';
    const fail = (status, message) => isAjax
        ? res.status(status).json({ error: message })
        : res.redirect(`/projects/${req.params.projectId}/settings?error=${encodeURIComponent(message)}`);
    if (!req.session.userId) return isAjax ? res.status(401).json({ error: 'Not authenticated' }) : res.redirect('/login');
    const { projectId } = req.params;
    const { userId: inviteeId, permission = 'view' } = req.body;
    const email = normalizeEmail(req.body.email);
    const project = await Projects.findById(projectId);
    if (!project || !project.owner.equals(req.session.userId)) return fail(403, 'Forbidden');
    if (!['view', 'edit'].includes(permission)) return fail(400, 'Choose a valid collaborator permission.');
    const inviter = await User.findById(req.session.userId).select('name plan');
    let invitee = null;
    if (inviteeId) {
        if (!mongoose.Types.ObjectId.isValid(inviteeId)) return fail(400, 'Invalid user.');
        invitee = await User.findById(inviteeId).select('name email');
        if (!invitee) return fail(404, 'User not found.');
    } else {
        if (!isValidEmail(email)) return fail(400, 'Enter a valid email address.');
        invitee = await User.findOne({ email: exactEmailPattern(email) }).select('name email');
    }
    if (!invitee) {
        if (!SIGNUPS_OPEN && !process.env.AUTH_HOST) {
            return fail(403, 'New accounts are disabled, so email invitations cannot be accepted on this instance.');
        }
        if (!process.env.EMAIL_HOST) return fail(503, 'Email invitations are not configured.');
        const emailPort = Number(process.env.EMAIL_PORT || 587);
        const emailFrom = process.env.EMAIL_FROM || process.env.EMAIL_USER;
        if (!Number.isInteger(emailPort) || emailPort < 1 || emailPort > 65535 || !emailFrom || (!!process.env.EMAIL_USER !== !!process.env.EMAIL_PASS)) {
            return fail(503, 'Email invitation settings are incomplete.');
        }

        const existing = (project.pendingCollabs || []).find(p => normalizeEmail(p.email) === email);
        if (existing) {
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            if (existing.invitedAt && existing.invitedAt > weekAgo) {
                return fail(409, `Already invited ${email} recently. Re-invite available after a week.`);
            }
        }

        const siteUrl = getPublicBaseUrl(req);
        const inviteUrl = `${siteUrl}/signup?email=${encodeURIComponent(email)}`;
        const projectName = String(project.name || 'a project').replace(/[\r\n]+/g, ' ');
        try {
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({
                host: process.env.EMAIL_HOST,
                port: emailPort,
                secure: emailPort === 465,
                ...(process.env.EMAIL_USER ? { auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } } : {})
            });
            await transporter.sendMail({
                from: emailFrom,
                to: email,
                subject: `You've been invited to collaborate on "${projectName}" in Catalogue`,
                html: `<p>${escapeHtml(inviter?.name || 'Someone')} invited you to collaborate on <strong>${escapeHtml(projectName)}</strong>.</p><p><a href="${escapeHtml(inviteUrl)}">Create an account</a> to accept.</p><p>This invitation was sent to ${escapeHtml(email)}.</p>`
            });
        } catch (error) {
            console.error('Collaborator invitation email failed:', error.message);
            return fail(502, 'Could not send the invitation email. Check the email settings and try again.');
        }

        project.pendingCollabs = project.pendingCollabs || [];
        if (existing) {
            existing.invitedAt = new Date();
            existing.permission = permission;
        } else {
            project.pendingCollabs.push({ email, permission, invitedAt: new Date() });
        }
        try {
            await project.save();
        } catch (error) {
            console.error('Could not save pending collaborator invitation:', error.message);
            return fail(500, 'The email was sent, but the invitation could not be recorded. Contact the project owner.');
        }
        const message = `Invitation email sent to ${email}.`;
        return isAjax ? res.json({ ok: true, message }) : res.redirect(`/projects/${projectId}/settings?success=${encodeURIComponent(message)}`);
    }
    if (project.owner.equals(invitee._id) || project.shared.some(s => s.person.equals(invitee._id))) {
        return isAjax ? res.json({ ok: true, message: 'Already a collaborator' }) : res.redirect(`/projects/${projectId}/settings?success=Already+a+collaborator`);
    }
    const collabLimit = planLimits(inviter).collaborators;
    if (project.shared.length >= collabLimit) {
        return fail(403, `Your plan allows up to ${collabLimit} collaborators.`);
    }
    project.shared.push({ person: invitee._id, permission });
    await project.save();
    // Send on-site notification to the new collaborator
    await createNotification(invitee._id, 'collab_invite',
        `${inviter?.name || 'Someone'} added you as a collaborator on "${project.name}".`,
        { projectId: project._id, fromUserId: req.session.userId, link: `/projects/${projectId}` });
    return isAjax ? res.json({ ok: true, message: `${invitee.name || email} added as collaborator` }) : res.redirect(`/projects/${projectId}/settings?success=${encodeURIComponent(invitee.name || email)}+added+as+collaborator`);
});

// Remove pending collab
app.post('/projects/:projectId/settings/removepending', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId } = req.params;
    const { email } = req.body;
    const project = await Projects.findById(projectId);
    if (!project || !project.owner.equals(req.session.userId)) return res.status(403).send('Forbidden');
    project.pendingCollabs = (project.pendingCollabs || []).filter(p => p.email !== email);
    await project.save();
    res.redirect(`/projects/${projectId}/settings`);
});

// ─── Catch-all project page ───────────────────────────────────────────────────

app.get('/projects/:projectId/:page', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const { projectId, page } = req.params;
    const project = await Projects.findById(projectId);
    if (!project) return render404Page(res);
    await renderProjectPage(res, { pageName: page, project, projectId, context: {}, title: page });
});

// ─── OAuth Routes ─────────────────────────────────────────────────────────────

const googleNotConfigured = (req, res) => res.status(503).send('Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env');
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
    app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), async (req, res) => {
        req.session.userId = req.user._id.toString();
        req.session.userName = req.user.name;
        res.redirect('/');
    });
} else {
    app.get('/auth/google', googleNotConfigured);
    app.get('/auth/google/callback', googleNotConfigured);
}

// ─── Public Profile Routes ────────────────────────────────────────────────────

app.get('/u/:username', async (req, res) => {
    const profileUser = await User.findOne({ username: req.params.username });
    if (!profileUser) return res.status(404).send('User not found');
    const projects = await Projects.find({ owner: profileUser._id, public: true }).sort({ lastUpdated: -1 }).limit(20);
    const isFollowing = req.session.userId ? profileUser.followers.map(f=>f.toString()).includes(req.session.userId) : false;
    const isSelf = req.session.userId === profileUser._id.toString();
    const pageHtml = fs.readFileSync(path.join(__dirname, 'views/pages/profile.ejs'), 'utf8');
    const layoutHtml = fs.readFileSync(path.join(__dirname, 'views/standard/page.ejs'), 'utf8');
    const inner = ejs.render(pageHtml, { profileUser, projects, isFollowing, isSelf, user: req.session.userId || null, name: 'Profile' });
    res.send(ejs.render(layoutHtml, { body: inner, name: profileUser.name + "'s Profile", user: req.session.userId || null, userName: req.session.userName || null, siteOrigin: req.protocol+'://'+req.get('host'), locals: {} }));
});

app.post('/u/:username/follow', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const profileUser = await User.findOne({ username: req.params.username });
    if (!profileUser) return res.status(404).json({ error: 'Not found' });
    const myId = req.session.userId;
    const idx = profileUser.followers.map(f=>f.toString()).indexOf(myId);
    if (idx === -1) {
        profileUser.followers.push(myId);
        await User.findByIdAndUpdate(myId, { $addToSet: { following: profileUser._id } });
    } else {
        profileUser.followers.splice(idx, 1);
        await User.findByIdAndUpdate(myId, { $pull: { following: profileUser._id } });
    }
    await profileUser.save();
    res.json({ following: idx === -1 });
});

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/projects/recent', async (req, res) => {
    if (!req.session.userId) return res.json([]);
    const projects = await Projects.find({ owner: req.session.userId }).sort({ lastUpdated: -1 }).limit(8).select('_id name color');
    res.json(projects);
});

app.get('/api/me/birthday', async (req, res) => {
    if (!req.session.userId) return res.json({ isBirthday: false });
    const user = await User.findById(req.session.userId).select('birthdate name');
    if (!user?.birthdate) return res.json({ isBirthday: false });
    const today = new Date(), bd = new Date(user.birthdate);
    const isBirthday = today.getMonth() === bd.getMonth() && today.getDate() === bd.getDate();
    res.json({ isBirthday, name: user.name });
});

app.get('/api/me', async (req, res) => {
    if (!req.session.userId) return res.json(null);
    const user = await User.findById(req.session.userId).select('name username plan avatar');
    res.json(user);
});

// ─── Markdown Export ──────────────────────────────────────────────────────────

app.get('/projects/:id/export/md', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Not authenticated');
    const project = await Projects.findById(req.params.id);
    if (!project) return res.status(404).send('Not found');
    let md = '# ' + project.name + '\n\n';
    if (project.description) md += '> ' + project.description + '\n\n';
    project.docs.forEach(doc => {
        md += '## ' + doc.title + '\n\n';
        doc.sections.forEach(sec => {
            md += '### ' + sec.title + '\n\n';
            if (sec.outline) md += '**Outline:** ' + sec.outline + '\n\n';
            if (sec.content) md += sec.content + '\n\n';
        });
    });
    project.characters.forEach(ch => {
        md += '## Character: ' + ch.name + '\n\n';
        if (ch.description) md += ch.description + '\n\n';
    });
    res.setHeader('Content-Disposition', 'attachment; filename="' + project.name.replace(/[^a-zA-Z0-9]/g,'-') + '.md"');
    res.setHeader('Content-Type', 'text/markdown');
    res.send(md);
});

// ─── Export: PDF (free) ───────────────────────────────────────────────────────
app.get('/projects/:id/export/pdf', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Not authenticated');
    const project = await Projects.findById(req.params.id);
    if (!project) return res.status(404).send('Not found');
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    res.setHeader('Content-Disposition', 'attachment; filename="' + project.name.replace(/[^a-zA-Z0-9]/g, '-') + '.pdf"');
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(24).font('Helvetica-Bold').text(project.name, { align: 'center' });
    if (project.description) {
        doc.moveDown(0.5).fontSize(13).font('Helvetica').fillColor('#666666').text(project.description, { align: 'center' });
        doc.fillColor('#000000');
    }
    project.docs.forEach(d => {
        doc.addPage().fontSize(18).font('Helvetica-Bold').text(d.title);
        d.sections.forEach(sec => {
            doc.moveDown(0.5).fontSize(14).font('Helvetica-Bold').text(sec.title);
            if (sec.outline) doc.moveDown(0.3).fontSize(11).font('Helvetica-Oblique').fillColor('#888888').text('Outline: ' + sec.outline).fillColor('#000000');
            if (sec.content) doc.moveDown(0.3).fontSize(12).font('Helvetica').text(sec.content, { lineGap: 3 });
        });
    });
    if (project.characters.length) {
        doc.addPage().fontSize(18).font('Helvetica-Bold').text('Characters');
        project.characters.forEach(ch => {
            doc.moveDown(0.5).fontSize(14).font('Helvetica-Bold').text(ch.name);
            if (ch.description) doc.moveDown(0.3).fontSize(12).font('Helvetica').text(ch.description);
        });
    }
    doc.end();
});

// ─── Export: EPUB (Pro+) ──────────────────────────────────────────────────────
app.get('/projects/:id/export/epub', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Not authenticated');
    const user = await User.findById(req.session.userId).select('plan');
    if (!['pro', 'studio'].includes(user?.plan)) return res.status(403).send('EPUB export is available on Pro and Studio plans.');
    const project = await Projects.findById(req.params.id);
    if (!project) return res.status(404).send('Not found');
    const AdmZipEpub = require('adm-zip');
    const zip = new AdmZipEpub();
    const slug = project.name.replace(/[^a-zA-Z0-9]/g, '-');
    const uid = 'catalogue-' + project._id;
    zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
    zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, 'utf8'));
    let toc = '', chapters = '';
    const chapterFiles = [];
    project.docs.forEach((d, di) => {
        const fn = 'ch' + di + '.xhtml';
        let body = '<h1>' + d.title + '</h1>';
        d.sections.forEach(sec => {
            body += '<h2>' + sec.title + '</h2>';
            if (sec.content) body += '<p>' + sec.content.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>') + '</p>';
        });
        zip.addFile(fn, Buffer.from(`<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${d.title}</title></head><body>${body}</body></html>`, 'utf8'));
        chapterFiles.push({ fn, title: d.title, id: 'ch' + di });
        toc += `<navPoint id="ch${di}" playOrder="${di+1}"><navLabel><text>${d.title}</text></navLabel><content src="${fn}"/></navPoint>`;
        chapters += `<item id="ch${di}" href="${fn}" media-type="application/xhtml+xml"/>`;
    });
    const spine = chapterFiles.map(c => `<itemref idref="${c.id}"/>`).join('');
    zip.addFile('content.opf', Buffer.from(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${project.name}</dc:title><dc:identifier id="uid">${uid}</dc:identifier><dc:language>en</dc:language></metadata><manifest>${chapters}</manifest><spine toc="ncx">${spine}</spine></package>`, 'utf8'));
    zip.addFile('toc.ncx', Buffer.from(`<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${project.name}</text></docTitle><navMap>${toc}</navMap></ncx>`, 'utf8'));
    res.setHeader('Content-Disposition', 'attachment; filename="' + slug + '.epub"');
    res.setHeader('Content-Type', 'application/epub+zip');
    res.send(zip.toBuffer());
});

// ─── Export: Mass ZIP (all projects) ─────────────────────────────────────────
app.get('/projects/export/all', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Not authenticated');
    const { format = 'md' } = req.query;
    const user = await User.findById(req.session.userId).select('plan');
    if (format === 'epub' && !['pro', 'studio'].includes(user?.plan))
        return res.status(403).send('EPUB export requires a Pro or Studio plan.');
    const projects = await Projects.find({ owner: req.session.userId });
    const AdmZipAll = require('adm-zip');
    const zip = new AdmZipAll();
    for (const project of projects) {
        const safe = project.name.replace(/[^a-zA-Z0-9]/g, '-');
        if (format === 'md') {
            let md = '# ' + project.name + '\n\n';
            if (project.description) md += '> ' + project.description + '\n\n';
            project.docs.forEach(d => {
                md += '## ' + d.title + '\n\n';
                d.sections.forEach(sec => {
                    md += '### ' + sec.title + '\n\n';
                    if (sec.outline) md += '**Outline:** ' + sec.outline + '\n\n';
                    if (sec.content) md += sec.content + '\n\n';
                });
            });
            project.characters.forEach(ch => {
                md += '## Character: ' + ch.name + '\n\n';
                if (ch.description) md += ch.description + '\n\n';
            });
            zip.addFile(safe + '/' + safe + '.md', Buffer.from(md, 'utf8'));
        } else if (format === 'epub') {
            const epubZip = new AdmZipAll();
            const uid = 'catalogue-' + project._id;
            epubZip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
            epubZip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, 'utf8'));
            let toc2 = '', chapters2 = '';
            const cfs = [];
            project.docs.forEach((d, di) => {
                const fn = 'ch' + di + '.xhtml';
                let body = '<h1>' + d.title + '</h1>';
                d.sections.forEach(sec => { body += '<h2>' + sec.title + '</h2>'; if (sec.content) body += '<p>' + sec.content.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>') + '</p>'; });
                epubZip.addFile(fn, Buffer.from(`<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${d.title}</title></head><body>${body}</body></html>`, 'utf8'));
                cfs.push({ fn, id: 'ch' + di, title: d.title });
                toc2 += `<navPoint id="ch${di}" playOrder="${di+1}"><navLabel><text>${d.title}</text></navLabel><content src="${fn}"/></navPoint>`;
                chapters2 += `<item id="ch${di}" href="${fn}" media-type="application/xhtml+xml"/>`;
            });
            const spine2 = cfs.map(c => `<itemref idref="${c.id}"/>`).join('');
            epubZip.addFile('content.opf', Buffer.from(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${project.name}</dc:title><dc:identifier id="uid">${uid}</dc:identifier><dc:language>en</dc:language></metadata><manifest>${chapters2}</manifest><spine toc="ncx">${spine2}</spine></package>`, 'utf8'));
            epubZip.addFile('toc.ncx', Buffer.from(`<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${project.name}</text></docTitle><navMap>${toc2}</navMap></ncx>`, 'utf8'));
            zip.addFile(safe + '/' + safe + '.epub', epubZip.toBuffer());
        }
    }
    res.setHeader('Content-Disposition', 'attachment; filename="catalogue-export.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.send(zip.toBuffer());
});

// ─── Import Routes ────────────────────────────────────────────────────────────

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Import Obsidian vault (.zip of .md files) or single .md file
app.post('/projects/:id/docs/import/md', importUpload.single('file'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const project = await Projects.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const buf = req.file && req.file.buffer;
    if (!buf) return res.status(400).json({ error: 'No file uploaded' });
    const mime = req.file.originalname.toLowerCase();
    try {
        if (mime.endsWith('.zip')) {
            const zip = new AdmZip(buf);
            const entries = zip.getEntries().filter(e => e.entryName.endsWith('.md') && !e.isDirectory);
            for (const entry of entries) {
                const text = entry.getData().toString('utf8');
                const title = entry.name.replace(/\.md$/i, '');
                project.docs.push({ title, sections: [{ title: 'Content', content: text, position: 0 }] });
            }
        } else {
            const text = buf.toString('utf8');
            const title = mime.replace(/\.md$/i, '');
            project.docs.push({ title, sections: [{ title: 'Content', content: text, position: 0 }] });
        }
        await project.save();
        res.json({ ok: true, count: project.docs.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Import Google Docs / Word (.docx via mammoth)
app.post('/projects/:id/docs/import/docx', importUpload.single('file'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const project = await Projects.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const buf = req.file && req.file.buffer;
    if (!buf) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const result = await mammoth.extractRawText({ buffer: buf });
        const text = result.value;
        const title = req.file.originalname.replace(/\.docx$/i, '');
        project.docs.push({ title, sections: [{ title: 'Content', content: text, position: 0 }] });
        await project.save();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Version Snapshots ────────────────────────────────────────────────────────

app.post('/projects/:projectId/docs/:docId/sections/:sectionId/versions/restore', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId, sectionId } = req.params;
    const { versionIndex } = req.body;
    const project = await Projects.findById(projectId);
    const section = project?.docs.id(docId)?.sections.id(sectionId);
    if (!section) return res.status(404).json({ error: 'Not found' });
    const v = section.versions[versionIndex];
    if (!v) return res.status(404).json({ error: 'Version not found' });
    section.content = v.content || section.content;
    section.outline = v.outline || section.outline;
    await project.save();
    res.json({ ok: true, content: section.content, outline: section.outline });
});

// ─── Activity Log ─────────────────────────────────────────────────────────────

app.get('/projects/:id/activity', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const project = await Projects.findById(req.params.id).select('activityLog');
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json(project.activityLog.slice(-50).reverse());
});

// ─── Reorder Sections ─────────────────────────────────────────────────────────

app.post('/projects/:projectId/docs/:docId/sections/reorder', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { projectId, docId } = req.params;
    const { orderedIds } = req.body;
    const project = await Projects.findById(projectId);
    const doc = project?.docs.id(docId);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const secMap = {};
    doc.sections.forEach(s => { secMap[s._id.toString()] = s; });
    doc.sections = orderedIds.map(id => secMap[id]).filter(Boolean);
    await project.save();
    res.json({ ok: true });
});

// ─── Billing ──────────────────────────────────────────────────────────────────

// ─── Billing: Stripe Checkout ─────────────────────────────────────────────────
app.post('/billing/checkout', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const { plan } = req.body;
    if (!['pro','studio'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
    const priceId = STRIPE_PRICES[plan];
    if (!priceId) return res.status(503).json({ error: 'Price not configured' });
    try {
        const user = await User.findById(req.session.userId).select('email stripeCustomerId');
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            customer: user.stripeCustomerId || undefined,
            customer_email: user.stripeCustomerId ? undefined : user.email,
            metadata: { userId: req.session.userId, plan },
            success_url: `${BILLING_URL}?success=1`,
            cancel_url: `${BILLING_URL}?cancelled=1`
        });
        res.json({ url: session.url });
    } catch(e) {
        console.error('Stripe checkout error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Billing: Cancel Subscription ─────────────────────────────────────────────
app.post('/billing/cancel', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.session.userId).select('stripeSubscriptionId');
    if (stripe && user.stripeSubscriptionId) {
        await stripe.subscriptions.cancel(user.stripeSubscriptionId);
    }
    await User.findByIdAndUpdate(req.session.userId, { plan: 'free', stripeSubscriptionId: null });
    res.json({ ok: true });
});

// ─── Dev: fast plan switch (dev accounts only) ────────────────────────────────
app.post('/dev/plan', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.session.userId).select('dev');
    if (!user?.dev) return res.status(403).json({ error: 'Not a dev account' });
    const { plan } = req.body;
    if (!['free','pro','studio'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    await User.findByIdAndUpdate(req.session.userId, { plan });
    res.json({ ok: true });
});

// ─── 404 helper ───────────────────────────────────────────────────────────────

function render404Page(res) {
    const pageFile = path.join(__dirname, 'views/pages/404.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return res.status(500).send('Internal Server Error');
        const content = await ejs.render(t, {}, { filename: pageFile });
        res.status(404).render('standard/page', { name: '404 - Page Not Found', body: content });
    });
}

// ─── Team Workspace model (Studio) ───────────────────────────────────────────
const TeamWorkspace = mongoose.model('TeamWorkspace', new Schema({
    name:        { type: String, required: true },
    description: String,
    owner:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members:     [{ userId: { type: Schema.Types.ObjectId, ref: 'User' }, role: { type: String, enum: ['admin', 'member'], default: 'member' }, joinedAt: { type: Date, default: Date.now } }],
    projects:    [{ type: Schema.Types.ObjectId, ref: 'Projects' }],
    createdAt:   { type: Date, default: Date.now }
}));

// Team workspace routes
app.get('/workspace', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = await User.findById(req.session.userId).select('plan name');
    if (user?.plan !== 'studio') {
        const body = '<div style="max-width:540px;margin:60px auto;text-align:center;"><h2>Team Workspace</h2><p style="opacity:0.7;margin-bottom:18px;">Team Workspace is available on the Studio plan.</p><a href="/billing" style="padding:9px 22px;border-radius:7px;background:var(--button-bg-color);color:inherit;text-decoration:none;font-size:14px;">View Plans</a></div>';
        return res.render('standard/page', { name: 'Team Workspace', body });
    }
    const myWorkspaces = await TeamWorkspace.find({ $or: [{ owner: req.session.userId }, { 'members.userId': req.session.userId }] }).lean();
    const pageFile = path.join(__dirname, 'views/pages/workspace.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) {
            const body = '<p style="opacity:0.5;text-align:center;margin-top:60px;">Workspace page not found.</p>';
            return res.render('standard/page', { name: 'Team Workspace', body });
        }
        const content = await ejs.render(t, { workspaces: myWorkspaces, user }, { filename: pageFile });
        res.render('standard/page', { name: 'Team Workspace', body: content });
    });
});

app.post('/workspace/create', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const user = await User.findById(req.session.userId).select('plan');
    if (user?.plan !== 'studio') return res.status(403).json({ error: 'Studio plan required' });
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const ws = await TeamWorkspace.create({ name: name.trim(), description: description || '', owner: req.session.userId, members: [{ userId: req.session.userId, role: 'admin' }] });
    res.json({ ok: true, workspace: { _id: ws._id, name: ws.name } });
});

app.get('/workspace/:id', async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const ws = await TeamWorkspace.findById(req.params.id).populate('members.userId', 'name email').populate('projects', 'name description lastUpdated').lean();
    if (!ws) return res.status(404).send('Workspace not found');
    const isMember = ws.owner.toString() === req.session.userId || ws.members.some(m => m.userId?._id?.toString() === req.session.userId);
    if (!isMember) return res.status(403).send('Access denied');
    const pageFile = path.join(__dirname, 'views/pages/workspaceDetail.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return res.status(500).send('Workspace detail page not found');
        const content = await ejs.render(t, { workspace: ws, userId: req.session.userId }, { filename: pageFile });
        res.render('standard/page', { name: ws.name, body: content });
    });
});

app.post('/workspace/:id/invite', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const ws = await TeamWorkspace.findById(req.params.id);
    if (!ws || ws.owner.toString() !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
    const { email } = req.body;
    const invitee = await User.findOne({ email }).select('name email');
    if (!invitee) return res.status(404).json({ error: 'User not found' });
    if (ws.members.some(m => m.userId?.toString() === invitee._id.toString())) return res.json({ ok: true, message: 'Already a member' });
    ws.members.push({ userId: invitee._id, role: 'member' });
    await ws.save();
    const inviter = await User.findById(req.session.userId).select('name');
    await createNotification(invitee._id, 'collab_invite', `${inviter?.name || 'Someone'} added you to the workspace "${ws.name}".`, { fromUserId: req.session.userId, link: `/workspace/${ws._id}` });
    res.json({ ok: true, message: `${invitee.name} added to workspace` });
});

app.post('/workspace/:id/add-project', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const ws = await TeamWorkspace.findById(req.params.id);
    if (!ws || ws.owner.toString() !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
    const { projectId } = req.body;
    if (!ws.projects.some(p => p.toString() === projectId)) ws.projects.push(projectId);
    await ws.save();
    res.json({ ok: true });
});

// ─── User Search (for collaborator invite) ────────────────────────────────────
app.get('/api/users/search', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({
        _id: { $ne: req.session.userId },
        $or: [{ name: regex }, { email: regex }, { username: regex }]
    }).select('name email username avatar').limit(8);
    res.json({ users });
});

// ─── Notification Routes ──────────────────────────────────────────────────────

app.get('/notifications', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    const notes = await Notification.find({ userId: req.session.userId }).sort({ createdAt: -1 }).limit(50);
    const unread = notes.filter(n => !n.read).length;
    if (req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        return res.json({ ok: true, notifications: notes, unread });
    }
    const pageFile = path.join(__dirname, 'views/pages/inbox.ejs');
    fs.readFile(pageFile, 'utf8', async (err, t) => {
        if (err) return res.status(500).send('Inbox page not found');
        const body = await ejs.render(t, { notifications: notes, unread }, { filename: pageFile });
        res.render('standard/page', { name: 'Inbox', body });
    });
});

app.post('/notifications/:id/read', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    await Notification.updateOne({ _id: req.params.id, userId: req.session.userId }, { read: true });
    res.json({ ok: true });
});

app.post('/notifications/read-all', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    await Notification.updateMany({ userId: req.session.userId, read: false }, { read: true });
    res.json({ ok: true });
});

app.get('/api/notifications/unread-count', async (req, res) => {
    if (!req.session.userId) return res.json({ count: 0 });
    const count = await Notification.countDocuments({ userId: req.session.userId, read: false });
    res.json({ count });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
