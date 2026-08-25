Here is the complete, self-contained index.js ready for deployment and immediate export to your repository. It includes the database auto-setup, Socket.io real-time engine, REST API endpoints, and the embedded live admin UI.
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);admin-logins

// Enable CORS for global access across external browser clients
app.use(cors({ origin: '*' }));
app.use(express.json());

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// CLOUD DATABASE POOL
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'crypto_invest_db',
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 10,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// AUTOMATED SCHEMA INITIALIZATION
async function initDb() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                country VARCHAR(100) NOT NULL,
                main_balance DECIMAL(15, 8) DEFAULT 0.00000000,
                investment_balance DECIMAL(15, 8) DEFAULT 0.00000000,
                total_profit DECIMAL(15, 8) DEFAULT 0.00000000,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS system_wallets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                coin VARCHAR(50) NOT NULL UNIQUE,
                wallet_address VARCHAR(255) NOT NULL,
                network VARCHAR(50) DEFAULT 'Mainnet'
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_email VARCHAR(255) NOT NULL,
                type ENUM('DEPOSIT', 'WITHDRAWAL', 'PROFIT_PAYOUT') NOT NULL,
                coin VARCHAR(20) NOT NULL,
                amount DECIMAL(15, 8) NOT NULL,
                status ENUM('PENDING', 'APPROVED', 'REJECTED') DEFAULT 'PENDING',
                tx_hash VARCHAR(255) DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('SUPER_ADMIN', 'SUPPORT_ADMIN') DEFAULT 'SUPER_ADMIN'
            )
        `);

        const [admins] = await db.query('SELECT id FROM admins LIMIT 1');
        if (admins.length === 0) {
            const hash = await bcrypt.hash(process.env.DEFAULT_ADMIN_PASS || 'AdminMaster2026!', 10);
            await db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', ['admin', hash, 'SUPER_ADMIN']);
            console.log('[DB] Created Default Admin User: admin');
        }

        await db.query(`
            INSERT IGNORE INTO system_wallets (coin, wallet_address, network) VALUES 
            ('BTC', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'Bitcoin Network'),
            ('USDT', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 'TRC20 / ERC20')
        `);

        console.log('[DB] Cloud database initialized.');
    } catch (err) {
        console.error('[DB Error]:', err.message);
    }
}
initDb();

// WEBSOCKET SUBSCRIBERS
io.on('connection', (socket) => {
    console.log('[Realtime] Live client connected:', socket.id);
});

// PUBLIC API: EXTERNAL REGISTER WEBSHOOK (Call from any frontend)
app.post('/api/register-user', async (req, res) => {
    try {
        const { email, country } = req.body;
        if (!email || !country) return res.status(400).json({ success: false, error: 'Email and Country required' });

        const [result] = await db.query(
            'INSERT INTO users (email, country) VALUES (?, ?) ON DUPLICATE KEY UPDATE country=VALUES(country)',
            [email, country]
        );

        const newUser = {
            id: result.insertId,
            email,
            country,
            main_balance: "0.00000000",
            investment_balance: "0.00000000",
            total_profit: "0.00000000"
        };

        // Broadcast user instantly to all open admin dashboards globally
        io.emit('NEW_USER_REGISTERED', newUser);

        res.json({ success: true, message: 'User registered across platforms' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ADMIN AUTHENTICATION MIDDLEWARE
const authenticateAdmin = async (req, res, next) => {
    const username = req.headers['x-admin-username'];
    const password = req.headers['x-admin-password'];
    if (!username || !password) return res.status(401).json({ success: false, error: 'Admin credentials missing' });

    try {
        const [rows] = await db.query('SELECT * FROM admins WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(401).json({ success: false, error: 'Invalid user' });

        const match = await bcrypt.compare(password, rows[0].password_hash);
        if (!match) return res.status(401).json({ success: false, error: 'Invalid password' });

        req.admin = rows[0];
        next();
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};

// ADMIN API ENDPOINTS
app.post('/api/admin/login', authenticateAdmin, (req, res) => {
    res.json({ success: true, admin: { username: req.admin.username, role: req.admin.role } });
});

app.get('/api/admin/overview', authenticateAdmin, async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users ORDER BY created_at DESC');
        const [wallets] = await db.query('SELECT * FROM system_wallets');
        res.json({ success: true, users, wallets });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/distribute-profit', authenticateAdmin, async (req, res) => {
    try {
        const { percentage } = req.body;
        const roi = parseFloat(percentage);
        if (isNaN(roi) || roi <= 0) return res.status(400).json({ success: false, error: 'Invalid ROI' });

        const mult = roi / 100;
        await db.query('UPDATE users SET total_profit = total_profit + (investment_balance * ?), main_balance = main_balance + (investment_balance * ?) WHERE investment_balance > 0', [mult, mult]);

        io.emit('PROFIT_DISTRIBUTED', { roi });
        res.json({ success: true, message: `Distributed ${roi}% ROI` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// SINGLE-FILE EMBEDDED DASHBOARD UI
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Crypto Central Admin Portal</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="/socket.io/socket.io.js"></script>
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans">
        
        <div id="loginModal" class="fixed inset-0 bg-slate-950 flex items-center justify-center p-4 z-50">
            <div class="bg-slate-900 p-6 rounded-xl border border-slate-800 w-full max-w-sm space-y-4 shadow-2xl">
                <h2 class="text-xl font-bold text-center text-white">Cloud Operations Login</h2>
                <input id="loginUser" type="text" placeholder="Username" class="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                <input id="loginPass" type="password" placeholder="Password" class="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                <button onclick="login()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-2 rounded text-sm font-medium transition">Authenticate</button>
            </div>
        </div>

        <div id="dashboard" class="max-w-7xl mx-auto space-y-6 hidden">
            <header class="flex justify-between items-center border-b border-slate-800 pb-4">
                <div>
                    <h1 class="text-2xl font-bold">Global Operations Center</h1>
                    <p class="text-xs text-slate-400">Connected to Distributed DB</p>
                </div>
                <div class="flex items-center space-x-2">
                    <span class="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span class="text-xs text-emerald-400 font-mono">Live Socket Active</span>
                </div>
            </header>

            <div class="grid md:grid-cols-2 gap-4">
                <div class="bg-slate-900 p-4 rounded-xl border border-slate-800 space-y-2">
                    <h2 class="text-xs font-semibold text-slate-400 uppercase">Mass ROI Profit Payout</h2>
                    <div class="flex space-x-2">
                        <input id="roiPercent" type="number" step="0.1" placeholder="Profit % (e.g. 5.0)" class="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                        <button onclick="distributeROI()" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded text-sm font-medium whitespace-nowrap transition">Distribute</button>
                    </div>
                </div>

                <div class="bg-slate-900 p-4 rounded-xl border border-slate-800 space-y-1 overflow-y-auto max-h-28">
                    <h2 class="text-xs font-semibold text-slate-400 uppercase">Active Deposit Wallets</h2>
                    <div id="walletsList" class="text-xs font-mono text-slate-300"></div>
                </div>
            </div>

            <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <table class="w-full text-left text-sm">
                    <thead class="bg-slate-950 text-slate-400 text-xs uppercase border-b border-slate-800">
                        <tr>
                            <th class="p-3">Investor Email</th>
                            <th class="p-3">Country</th>
                            <th class="p-3">Main Balance</th>
                            <th class="p-3">Active Capital</th>
                            <th class="p-3">Total Profit</th>
                        </tr>
                    </thead>
                    <tbody id="userTable" class="divide-y divide-slate-800"></tbody>
                </table>
            </div>
        </div>

        <script>
            let headers = {};
            const socket = io();

            socket.on('NEW_USER_REGISTERED', (user) => {
                const tbody = document.getElementById('userTable');
                if (tbody) {
                    const row = document.createElement('tr');
                    row.className = 'bg-indigo-950/40 transition duration-500';
                    row.innerHTML = \`
                        <td class="p-3 font-medium text-white">\${user.email} <span class="text-[10px] bg-indigo-500 text-white px-1.5 py-0.5 rounded ml-2">JUST NOW</span></td>
                        <td class="p-3 text-slate-400 text-xs">\${user.country}</td>
                        <td class="p-3 text-emerald-400 font-mono">\$\${parseFloat(user.main_balance).toFixed(2)}</td>
                        <td class="p-3 text-indigo-400 font-mono">\$\${parseFloat(user.investment_balance).toFixed(2)}</td>
                        <td class="p-3 text-sky-400 font-mono">\$\${parseFloat(user.total_profit).toFixed(2)}</td>
                    \`;
                    tbody.prepend(row);
                }
            });

            async function login() {
                const user = document.getElementById('loginUser').value;
                const pass = document.getElementById('loginPass').value;
                headers = { 'Content-Type': 'application/json', 'x-admin-username': user, 'x-admin-password': pass };

                const res = await fetch('/api/admin/login', { method: 'POST', headers });
                const data = await res.json();
                if(data.success) {
                    document.getElementById('loginModal').classList.add('hidden');
                    document.getElementById('dashboard').classList.remove('hidden');
                    loadData();
                } else { alert(data.error); }
            }

            async function loadData() {
                const res = await fetch('/api/admin/overview', { headers });
                const data = await res.json();
                
                const walletContainer = document.getElementById('walletsList');
                walletContainer.innerHTML = '';
                data.wallets.forEach(w => {
                    walletContainer.innerHTML += \`<div><span class="text-indigo-400">\${w.coin}:</span> \${w.wallet_address}</div>\`;
                });

                const tbody = document.getElementById('userTable');
                tbody.innerHTML = '';
                data.users.forEach(u => {
                    tbody.innerHTML += \`
                        <tr class="hover:bg-slate-800/40">
                            <td class="p-3 font-medium text-white">\${u.email}</td>
                            <td class="p-3 text-slate-400 text-xs">\${u.country}</td>
                            <td class="p-3 text-emerald-400 font-mono">\$\${parseFloat(u.main_balance).toFixed(2)}</td>
                            <td class="p-3 text-indigo-400 font-mono">\$\${parseFloat(u.investment_balance).toFixed(2)}</td>
                            <td class="p-3 text-sky-400 font-mono">\$\${parseFloat(u.total_profit).toFixed(2)}</td>
                        </tr>
                    \`;
                });
            }

            async function distributeROI() {
                const percentage = document.getElementById('roiPercent').value;
                const res = await fetch('/api/admin/distribute-profit', { method: 'POST', headers, body: JSON.stringify({ percentage }) });
                const data = await res.json();
                alert(data.message || data.error);
                loadData();
            }
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Server] Live dashboard running on port ${PORT}`));


                       
