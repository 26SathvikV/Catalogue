const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const fs = require('fs');

if (!app.isPackaged) {
    dotenv.config({ path: path.join(__dirname, '.env') });
    require('./index.js');
}

function waitForServer(url, cb, retries = 30) {
    http.get(url, cb).on('error', () => {
        if (retries > 0) setTimeout(() => waitForServer(url, cb, retries - 1), 200);
    });
}

let mainWindow;

function createWindow(url) {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        title: 'Catalogue',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    const appOrigin = new URL(url).origin;
    mainWindow.loadURL(url);

    mainWindow.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
        if (new URL(openedUrl).origin !== appOrigin) {
            shell.openExternal(openedUrl);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
}

app.whenReady().then(() => {
    if (app.isPackaged) {
        try {
            const configPath = path.join(process.resourcesPath, '..', 'catalogue-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const catalogueUrl = new URL(config.url);
            if (catalogueUrl.protocol !== 'https:') throw new Error('The hosted app URL must use HTTPS.');
            createWindow(catalogueUrl.origin);
        } catch (error) {
            dialog.showErrorBox('Catalogue is not configured', 'The desktop build needs a valid HTTPS CATALOGUE_URL to the hosted Catalogue app.');
            app.quit();
        }
        return;
    }

    waitForServer('http://localhost:4000', () => createWindow('http://localhost:4000'));
});

app.on('window-all-closed', () => app.quit());
