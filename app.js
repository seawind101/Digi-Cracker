const express = require('express');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = parseInt(process.env.PORT || '422', 10);
const FORMBAR_ADDRESS = (process.env.FORMBAR_ADDRESS || 'http://localhost:420').replace(/\/$/, '');
const PUBLIC_KEY = process.env.PUBLIC_KEY || '';
const app = express();
const server = http.createServer(app);

// Change this object to change the transfer sent when the application starts.
const STARTUP_TRANSFER_PAYLOAD = {
    from: 127,
    to: 43,
    amount: 2,
    pin: '000000',
    reason: 'help',
    pool: false,
};
const MAX_STARTUP_PIN = 999999;
let startupPinLocked = false;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
    res.render('index', {
        config: {
            FORMBAR_ADDRESS,
            HAS_PUBLIC_KEY: Boolean(PUBLIC_KEY),
            STARTUP_TRANSFER_PAYLOAD,
        }
    });
});

function logSuccessfulTransfer(payload) {
    console.log('Transfer payload:', { ...payload }, 'success');
}

function logFailedTransfer(payload) {
    console.log('Transfer failed PIN:', payload.pin);
}

function formatStartupPin(pin) {
    return String(Math.min(pin, MAX_STARTUP_PIN)).padStart(6, '0');
}

function reserveStartupTransferPayload() {
    const payload = { ...STARTUP_TRANSFER_PAYLOAD };
    if (!startupPinLocked && Number(payload.pin) < MAX_STARTUP_PIN) {
        STARTUP_TRANSFER_PAYLOAD.pin = formatStartupPin(Number(payload.pin) + 1);
    }
    return payload;
}

function recordSuccessfulStartupTransfer(payload) {
    logSuccessfulTransfer(payload);
    if (!startupPinLocked) {
        STARTUP_TRANSFER_PAYLOAD.pin = payload.pin;
        startupPinLocked = true;
    }
}

function transferStartupPayload() {
    const payload = reserveStartupTransferPayload();
    return new Promise((resolve, reject) => {
        const socket = io(FORMBAR_ADDRESS, { reconnection: false });
        let fallbackStarted = false;
        let timeout;

        function fallbackToHttp(reason) {
            if (fallbackStarted) return;
            fallbackStarted = true;
            clearTimeout(timeout);
            socket.close();
            sendTransfer(payload)
                .then(({ status, json }) => {
                    if (status >= 200 && status < 300 && json?.success) {
                        recordSuccessfulStartupTransfer(payload);
                        resolve({ ...json, transport: 'http-fallback' });
                    } else {
                        logFailedTransfer(payload);
                        resolve({
                            ...(json || { success: false, message: `HTTP fallback returned ${status}` }),
                            transport: 'http-fallback',
                            status,
                        });
                    }
                })
                .catch((error) => {
                    logFailedTransfer(payload);
                    reject(new Error(`${reason}; HTTP fallback failed: ${error.message}`));
                });
        }

        timeout = setTimeout(() => {
            fallbackToHttp('Socket response timed out');
        }, 10000);

        socket.once('connect', () => {
            socket.emit('transferDigipogs', payload);
        });

        socket.once('transferResponse', (result) => {
            clearTimeout(timeout);
            socket.close();
            if (result?.success) {
                recordSuccessfulStartupTransfer(payload);
            } else {
                logFailedTransfer(payload);
            }
            resolve(result);
        });

        socket.once('connect_error', (error) => {
            fallbackToHttp(`Socket connection failed: ${error.message}`);
        });
    });
}

app.get('/transfer-on-load', async (_req, res) => {
    try {
        const result = await transferStartupPayload();
        res.json({ ok: result?.success !== false, result });
    } catch (error) {
        res.status(502).json({ ok: false, error: error.message });
    }
});

async function sendTransfer(payload) {
    // Send the transfer request to Formbar
    const transferURL = `${FORMBAR_ADDRESS}/api/digipogs/transfer`;
    const transferPayload = { ...payload, pin: String(payload.pin) };
    const res = await fetch(transferURL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(transferPayload),
    });

    // Parse the response and return it
    const text = await res.text();
    const json = JSON.parse(text);
    return { status: res.status, json };
}

app.post('/transfer', async (req, res) => {
    try {
        // Validate input
        const { from, to, amount, pin, reason } = req.body || {};
        if (!from || !to || !amount || pin == null) {
            res.status(400).json({ ok: false, error: 'Missing required fields' });
            return;
        }

        // Prepare the payload that will be sent to Formbar
        const payload = {
            from: Number(from),
            to: Number(to),
            amount: Number(amount),
            pin: String(pin),
            reason: String(reason || 'Transfer'),
        };

        // Send the transfer request and check if the response is valid
        const { status, json } = await sendTransfer(payload);
        const token = json?.token;
        if (!token) {
            res.status(status).json({ ok: false, error: 'Invalid response from Formbar API (no token)', response: json });
            return;
        }

        // Decode and verify the JWT token if we have a public key
        // If no public key is set, we just decode it without verification
        let decoded;
        if (PUBLIC_KEY) {
            try {
                decoded = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] });
            } catch (e) {
                res.status(200).json({ ok: false, error: 'JWT verify failed', token });
                return;
            }
        } else {
            try { decoded = jwt.decode(token); } catch {}
        }

        if (decoded?.success) {
            logSuccessfulTransfer(payload);
        }

        // Return the result
        res.status(200).json({ ok: Boolean(decoded?.success), message: decoded?.message || null, token, decoded });
    } catch (err) {
        res.status(502).json({ ok: false, error: 'HTTP request to Formbar failed', details: err?.message || String(err) });
    }
});

server.listen(PORT, () => {
    console.log(`DigipogTester running at http://localhost:${PORT}`);
    console.log(`Formbar address: ${FORMBAR_ADDRESS}`);
    console.log(`Public key loaded: ${Boolean(PUBLIC_KEY)}`);
});


