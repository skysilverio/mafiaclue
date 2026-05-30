require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// STATE & CONSTANTS
// ==========================================
let players = {};
let gameState = 'LOGIN';
let roundNumber = 0;
let gameConfig = {};
let hostSocketId = null;
global.gameTheme = 'default';

const DEFAULT_WEAPONS = ['Knife', 'Candlestick', 'Revolver', 'Rope', 'Poison', 'Wrench'];
const DEFAULT_LOCATIONS = ['Hall', 'Lounge', 'Dining Room', 'Kitchen', 'Ballroom', 'Conservatory', 'Library'];
let activeWeapons = [];
let activeLocations = [];
let trueMurderer = null;
let trueWeapon = null;
let trueLocation = null;

let interrogationQueue = [];
let currentInterrogatorId = null;
let currentInterrogationState = {};

let phaseEndTime = 0;
let phaseTimeoutId = null;
let nightTimerEndTime = 0;

let dayVotes = {};
let finaleGuesses = {};
let readyPlayers = new Set();

// Advanced Role State
let vigilanteBullets = {};
let activeVoodooCurse = null;
let jammedPlayers = new Set();
let nightActions = {};
let nightSequence = [];
let currentNightRole = null;
let nightTimerTimeout = null;
let expectedNightSubmissions = 0;
let currentNightSubmissions = 0;
let nightTurnActive = false;

// Server-side clue board state
let clueBoardState = {};

// Game event log for post-game recap
let gameLog = [];
let perfectGuessThisRound = false;

// Circuit breaker for AI narrator
let aiFailureCount = 0;
const AI_CIRCUIT_BREAKER_LIMIT = 3;

// AI Options — controlled by host config (Feature 6)
let aiOptions = {
    aiNarrationEnabled: true,
    manualPhaseProgression: false,
    timerPaused: false,
    liveActionFeedEnabled: false,
    revealCluePoisoning: false,
    manualRolePrompting: false
};

// Live action feed log for host (Feature 6d)
let liveActionFeed = [];

// Timer pause state
let pausedTimeRemaining = 0;
let pausedTimerType = null; // 'phase' | 'night'

// ==========================================
// HELPERS
// ==========================================
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
function getPlayerBySocket(sockId) { return Object.values(players).find(p => p.socketId === sockId); }
function narratorBroadcast(message, isNight = false) { io.emit('narrator_event', { msg: message, isNight }); }
function isMafiaTeam(role) { return ['Mafia', 'Godfather', 'Framer', 'Voodoo Lady', 'Logic Jammer', 'Consigliere', 'Mafia Murderer', 'Mafia Accomplice'].includes(role); }
function roleInGame(role) { return Object.values(players).some(p => p.role === role && p.isAlive); }
function broadcastGraveyard() { io.emit('graveyard_update', Object.values(players).map(p => ({ id: p.id, name: p.name, isAlive: p.isAlive, role: p.isAlive ? null : (gameConfig.blindExecutions ? '???' : p.role) }))); }
function logEvent(type, description) { gameLog.push({ round: roundNumber, type, description }); }
function broadcastGameEvent(icon, message, type = 'info') { io.emit('game_event', { icon, message, type }); }

// Feature 6d: Push live action to host feed
function pushLiveFeed(entry) {
    liveActionFeed.push(entry);
    if (hostSocketId) io.to(hostSocketId).emit('live_feed_update', entry);
}

function calculateTTSDuration(text) {
    const wordCount = text.split(/\s+/).length;
    return Math.ceil((wordCount / 2.5) * 1000) + 1500;
}
async function narratorBroadcastAndWait(message, isNight = false) {
    // Feature 6a: If AI narration disabled, still broadcast but don't delay for AI-generated lines
    narratorBroadcast(message, isNight);
    await new Promise(resolve => setTimeout(resolve, calculateTTSDuration(message)));
}

function getDisplayRole(player) {
    if (!player.role) return 'Unknown';
    let role = player.role;
    if (role === 'Mafia') role = player.id === trueMurderer ? 'Mafia Murderer' : 'Mafia Accomplice';
    if (isMafiaTeam(role) && player.id === trueMurderer && role !== 'Mafia Murderer') {
        return `${role} (The Murderer)`;
    }
    return role;
}

// ==========================================
// AI NARRATOR
// ==========================================
const FALLBACK_STORIES = [
    'The atmosphere grows thick with tension as secrets simmer beneath the surface.',
    'A chill hangs in the air as the events unfold with grim inevitability.',
    'The shadows deepen as the mystery tightens its grip on the assembled guests.',
    'Whispers echo through the halls as the night presses on relentlessly.',
    'The truth lies buried beneath layers of deception and mistrust.'
];

async function getAIStory(theme, contextPrompt, retries = 4) {
    // Feature 6a: Respect AI narration toggle
    if (!aiOptions.aiNarrationEnabled) return '';

    if (aiFailureCount >= AI_CIRCUIT_BREAKER_LIMIT) {
        console.log('[AI Narrator] Circuit breaker active — using fallback.');
        return FALLBACK_STORIES[Math.floor(Math.random() * FALLBACK_STORIES.length)];
    }
    const activeTheme = theme || 'classic mystery';
    const safetySettings = [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ];
    const modelQueue = ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash-lite-001'];
    const prompt = `You are the dramatic narrator of a Mafia/Clue mystery game. Theme: "${activeTheme}". ${contextPrompt} Write a highly atmospheric 2 to 3 sentence story. No quotes.`;

    for (let i = 0; i <= retries; i++) {
        const modelName = modelQueue[i % modelQueue.length];
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('AI request timed out after 10s')), 10000)
            );
            const result = await Promise.race([model.generateContent(prompt), timeoutPromise]);
            aiFailureCount = 0;
            return result.response.text().trim();
        } catch (e) {
            console.log(`[AI Narrator] ${modelName} failed: ${e.message.slice(0, 80)}`);
            aiFailureCount++;
            if (aiFailureCount >= AI_CIRCUIT_BREAKER_LIMIT) return FALLBACK_STORIES[Math.floor(Math.random() * FALLBACK_STORIES.length)];
            if (i < retries) await new Promise(resolve => setTimeout(resolve, Math.min(2000 * Math.pow(2, i), 16000)));
        }
    }
    return FALLBACK_STORIES[Math.floor(Math.random() * FALLBACK_STORIES.length)];
}

function generateUniqueMafiaClue() {
    const weaponPool = activeWeapons.filter(w => w !== trueWeapon);
    const locationPool = activeLocations.filter(l => l !== trueLocation);
    const useWeapon = weaponPool.length > 0 && (locationPool.length === 0 || Math.random() > 0.5);
    if (useWeapon) return `🔎 Clue: The true weapon is NOT the ${weaponPool[Math.floor(Math.random() * weaponPool.length)]}.`;
    if (locationPool.length > 0) return `🔎 Clue: The murder did NOT happen in the ${locationPool[Math.floor(Math.random() * locationPool.length)]}.`;
    return `🔎 Clue: The investigation continues...`;
}

function resetGameState() {
    roundNumber = 0;
    interrogationQueue = [];
    dayVotes = {};
    finaleGuesses = {};
    nightActions = {};
    nightSequence = [];
    currentNightRole = null;
    activeVoodooCurse = null;
    jammedPlayers.clear();
    currentInterrogationState = {};
    nightTurnActive = false;
    vigilanteBullets = {};
    clueBoardState = {};
    gameLog = [];
    liveActionFeed = [];
    aiFailureCount = 0;
    perfectGuessThisRound = false;
    pausedTimeRemaining = 0;
    pausedTimerType = null;
    clearTimeout(phaseTimeoutId);
    clearTimeout(nightTimerTimeout);
}

// ==========================================
// CORE SOCKET LOGIC
// ==========================================
io.on('connection', (socket) => {

    socket.on('claim_host', () => {
        if (!hostSocketId) {
            hostSocketId = socket.id;
            io.to(socket.id).emit('host_success');
            // BUG 5 FIX: Always send phase_change to host so they see correct screen on claim
            io.to(socket.id).emit('phase_change', gameState);
            io.emit('update_players', Object.values(players));
            if (trueMurderer) {
                io.to(socket.id).emit('host_truth', {
                    murdererName: players[trueMurderer]?.name,
                    murdererRole: players[trueMurderer]?.role,
                    weapon: trueWeapon,
                    location: trueLocation
                });
            }
            // Send current AI options to reconnecting host
            io.to(socket.id).emit('ai_options_update', aiOptions);
        }
    });

    socket.on('join_lobby', (data) => {
        if (players[data.id]) {
            players[data.id].socketId = socket.id;
            players[data.id].name = data.name;
            io.emit('update_players', Object.values(players));
            return;
        }
        players[data.id] = { id: data.id, socketId: socket.id, name: data.name, role: null, isAlive: true };
        io.emit('update_players', Object.values(players));
    });

    socket.on('rejoin_attempt', (playerId) => {
        const player = players[playerId];
        if (player && player.kicked) { io.to(socket.id).emit('you_were_kicked'); return; }
        if (!player || gameState === 'LOGIN' || gameState === 'LOBBY') return;

        player.socketId = socket.id;
        if (isMafiaTeam(player.role)) socket.join('mafia_room');

        io.to(socket.id).emit('rejoin_success', player);
        io.to(socket.id).emit('phase_change', gameState);

        if (player.role) {
            io.to(socket.id).emit('role_assigned', {
                displayRole: getDisplayRole(player),
                coreRole: player.role,
                playerList: Object.values(players),
                weapons: activeWeapons,
                locations: activeLocations
            });
        }
        broadcastGraveyard();

        if (clueBoardState[playerId]) io.to(socket.id).emit('restore_clue_board', clueBoardState[playerId]);

        if (gameState === 'INTRO' && isMafiaTeam(player.role)) {
            const remaining = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
            const mafiaRoster = Object.values(players).filter(p => isMafiaTeam(p.role)).map(p => `${p.name} (${getDisplayRole(p)})`).join(', ');
            io.to(socket.id).emit('open_mafia_intro_chat', { roster: mafiaRoster, time: remaining });
        }

        if (gameState === 'INTERROGATION' && currentInterrogationState.status) {
            const reconnectState = { ...currentInterrogationState };
            if (reconnectState.status === 'TICKING') {
                reconnectState.duration = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
                io.to(socket.id).emit('interrogation_update', reconnectState);
                // BUG 4 FIX: Only re-send guess prompt to the ACTIVE interrogator, not all players
                if (reconnectState.activePlayerId === playerId) {
                    const list = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
                    io.to(socket.id).emit('prompt_clue_guess', { weapons: activeWeapons, locations: activeLocations, playerList: list });
                }
            } else {
                io.to(socket.id).emit('interrogation_update', reconnectState);
            }
        } else if (gameState === 'DAY' || gameState === 'DAY_VOTE' || gameState === 'TALLYING') {
            const remaining = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
            if (gameState === 'DAY') io.to(socket.id).emit('start_day_timer', remaining);
            if (gameState === 'DAY_VOTE' || gameState === 'TALLYING') {
                io.to(socket.id).emit('start_day_vote_timer', remaining);
                if (gameState === 'DAY_VOTE' && !dayVotes[playerId] && players[playerId].isAlive) {
                    const aliveList = Object.values(players).filter(p => p.isAlive).map(p => ({ id: p.id, name: p.name }));
                    io.to(socket.id).emit('prompt_day_vote', aliveList);
                }
            }
        } else if (gameState === 'NIGHT' && player.isAlive && currentNightRole) {
            let validTargets = Object.values(players).filter(p => p.isAlive);
            if (currentNightRole === 'Voodoo Lady') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));
            const remaining = Math.max(0, Math.round((nightTimerEndTime - Date.now()) / 1000));
            if ((currentNightRole === 'Mafia' && isMafiaTeam(player.role)) || currentNightRole === player.role) {
                io.to(socket.id).emit('night_action_phase', { role: currentNightRole, time: remaining, players: validTargets.map(p => ({ id: p.id, name: p.name })), weapons: activeWeapons, locations: activeLocations });
            }
        } else if (gameState === 'FINALE' && player.isAlive) {
            const finalePlayerList = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
            io.to(socket.id).emit('prompt_finale_guess', { weapons: activeWeapons, locations: activeLocations, playerList: finalePlayerList });
        }
    });

    socket.on('mafia_chat', (msg) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !isMafiaTeam(p.role)) return;
        io.to('mafia_room').emit('mafia_chat_update', { sender: p.name, msg });
    });

    socket.on('mafia_intro_chat', (msg) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !isMafiaTeam(p.role) || gameState !== 'INTRO') return;
        io.to('mafia_room').emit('mafia_intro_chat_update', { sender: p.name, roleTag: getDisplayRole(p), msg });
    });

    socket.on('player_ready', () => {
        const p = getPlayerBySocket(socket.id);
        if (p && p.isAlive && gameState === 'DAY') {
            readyPlayers.add(p.id);
            const aliveCount = Object.values(players).filter(pl => pl.isAlive).length;
            io.emit('ready_count_update', readyPlayers.size, aliveCount);
            if (readyPlayers.size >= aliveCount) { clearTimeout(phaseTimeoutId); startDayVoting(); }
        }
    });

    socket.on('update_clue_board', (data) => {
        const p = getPlayerBySocket(socket.id);
        if (!p) return;
        if (!clueBoardState[p.id]) clueBoardState[p.id] = {};
        clueBoardState[p.id][data.name] = data.state;
    });

    // ------------------------------------------
    // HOST GOD MODE
    // ------------------------------------------
    socket.on('host_kick_player', (pId) => {
        if (socket.id !== hostSocketId) return;
        const target = players[pId];
        if (!target) return;
        const kickedSocket = io.sockets.sockets.get(target.socketId);
        if (kickedSocket) { kickedSocket.emit('you_were_kicked'); kickedSocket.leave('mafia_room'); }
        delete players[pId];
        io.emit('update_players', Object.values(players));
        broadcastGraveyard();
    });

    socket.on('host_force_next', () => {
        if (socket.id !== hostSocketId) return;
        clearTimeout(phaseTimeoutId);
        clearTimeout(nightTimerTimeout);
        if (gameState === 'DAY') startDayVoting();
        else if (gameState === 'DAY_VOTE') tallyDayVotes();
        else if (gameState === 'INTERROGATION') nextInterrogationTurn();
        else if (gameState === 'NIGHT') {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            (async () => {
                io.emit('close_night_action');
                await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
                processNextNightTurn();
            })();
        }
    });

    socket.on('host_inject_clue', () => {
        if (socket.id !== hostSocketId) return;
        const clue = generateUniqueMafiaClue();
        narratorBroadcast(clue, false);
        broadcastGameEvent('🔎', clue, 'info');
    });

    socket.on('host_force_kill', (pId) => {
        if (socket.id !== hostSocketId) return;
        const target = players[pId];
        if (!target || !target.isAlive) return;
        target.isAlive = false;
        logEvent('force_kill', `Round ${roundNumber}: ${target.name} was removed from the game by the Host.`);
        narratorBroadcast(`${target.name} has been removed from the game.`, false);
        broadcastGraveyard();
        io.to(target.socketId).emit('close_night_action');

        if (gameState === 'INTERROGATION' && currentInterrogatorId === pId) {
            clearTimeout(phaseTimeoutId);
            nextInterrogationTurn();
        }
        if (gameState === 'DAY_VOTE' && !dayVotes[pId]) {
            dayVotes[pId] = 'SKIP';
            if (Object.keys(dayVotes).length === Object.values(players).filter(p => p.isAlive || p.id === pId).length) {
                clearTimeout(phaseTimeoutId); tallyDayVotes();
            }
        }
        if (gameState === 'NIGHT' && nightTurnActive && !nightActions.submissions.has(pId)) {
            nightActions.submissions.add(pId);
            currentNightSubmissions = nightActions.submissions.size;
            if (currentNightSubmissions >= expectedNightSubmissions && expectedNightSubmissions > 0) {
                if (!nightTurnActive) return;
                nightTurnActive = false;
                clearTimeout(nightTimerTimeout);
                (async () => {
                    await new Promise(res => setTimeout(res, 1000));
                    io.emit('close_night_action');
                    await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
                    await new Promise(res => setTimeout(res, 1000));
                    processNextNightTurn();
                })();
            }
        }
    });

    // Feature 6: Update AI options from host panel
    socket.on('update_ai_options', (opts) => {
        if (socket.id !== hostSocketId) return;
        aiOptions = { ...aiOptions, ...opts };
        // Broadcast updated options back to host
        io.to(hostSocketId).emit('ai_options_update', aiOptions);
    });

    // Feature 6c: Pause/resume timer
    socket.on('host_pause_timer', () => {
        if (socket.id !== hostSocketId) return;
        if (!aiOptions.timerPaused) {
            // Pause: save remaining time and clear timeouts
            aiOptions.timerPaused = true;
            if (gameState === 'NIGHT') {
                pausedTimeRemaining = Math.max(0, Math.round((nightTimerEndTime - Date.now()) / 1000));
                pausedTimerType = 'night';
                clearTimeout(nightTimerTimeout);
            } else {
                pausedTimeRemaining = Math.max(0, Math.round((phaseEndTime - Date.now()) / 1000));
                pausedTimerType = 'phase';
                clearTimeout(phaseTimeoutId);
            }
            io.emit('timer_paused', { remaining: pausedTimeRemaining });
            io.to(hostSocketId).emit('ai_options_update', aiOptions);
        } else {
            // Resume: restart the timer with saved remaining time
            aiOptions.timerPaused = false;
            if (pausedTimerType === 'night') {
                nightTimerEndTime = Date.now() + pausedTimeRemaining * 1000;
                nightTimerTimeout = setTimeout(async () => {
                    if (!nightTurnActive) return;
                    nightTurnActive = false;
                    io.emit('close_night_action');
                    await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
                    await new Promise(res => setTimeout(res, 1000));
                    processNextNightTurn();
                }, pausedTimeRemaining * 1000);
            } else if (pausedTimerType === 'phase') {
                phaseEndTime = Date.now() + pausedTimeRemaining * 1000;
                if (gameState === 'DAY') phaseTimeoutId = setTimeout(startDayVoting, pausedTimeRemaining * 1000);
                else if (gameState === 'DAY_VOTE') phaseTimeoutId = setTimeout(tallyDayVotes, pausedTimeRemaining * 1000);
            }
            io.emit('timer_resumed', { remaining: pausedTimeRemaining });
            io.to(hostSocketId).emit('ai_options_update', aiOptions);
        }
    });

    // Feature 6f: Manual role prompting — host wakes up a specific role
    socket.on('host_wake_role', (role) => {
        if (socket.id !== hostSocketId) return;
        if (gameState !== 'NIGHT' || !aiOptions.manualRolePrompting) return;
        // Remove the role from the queue if it's there and push it as current
        nightSequence = nightSequence.filter(r => r !== role);
        // Directly process this role turn
        const rolePlayers = Object.values(players).filter(p => role === 'Mafia' ? isMafiaTeam(p.role) : p.role === role);
        const livingRolePlayers = rolePlayers.filter(p => p.isAlive);
        if (livingRolePlayers.length === 0) return;

        if (currentNightRole) io.emit('close_night_action');
        currentNightRole = role;
        nightActions.submissions = new Set();
        expectedNightSubmissions = livingRolePlayers.length;
        currentNightSubmissions = 0;
        nightTurnActive = true;

        const time = 30;
        nightTimerEndTime = Date.now() + time * 1000;
        let validTargets = Object.values(players).filter(p => p.isAlive);
        if (role === 'Socialite') validTargets = validTargets.filter(p => !livingRolePlayers.some(lp => lp.id === p.id));
        if (role === 'Mafia') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));
        if (role === 'Voodoo Lady') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));

        const msg = role === 'Mafia' ? 'Mafia, open your eyes.' : `${role}, open your eyes.`;
        narratorBroadcast(msg, true);

        livingRolePlayers.forEach(p => {
            io.to(p.socketId).emit('night_action_phase', { role, time, players: validTargets.map(v => ({ id: v.id, name: v.name })), weapons: activeWeapons, locations: activeLocations });
        });

        nightTimerTimeout = setTimeout(async () => {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            io.emit('close_night_action');
            await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
            await new Promise(res => setTimeout(res, 1000));
            processNextNightTurn();
        }, time * 1000);
    });

    // ------------------------------------------
    // GAME START
    // ------------------------------------------
    socket.on('start_game', async (config) => {
        gameConfig = config;
        const playerIds = Object.keys(players);

        let mPool = [];
        if (config.roles.godfather) mPool.push('Godfather');
        if (config.roles.voodoo) mPool.push('Voodoo Lady');
        if (config.roles.framer) mPool.push('Framer');
        if (config.roles.jammer) mPool.push('Logic Jammer');
        if (config.roles.consigliere) mPool.push('Consigliere');
        mPool = shuffle(mPool);

        let tPool = [];
        if (config.roles.doctor) tPool.push('Doctor');
        if (config.roles.detective) tPool.push('Detective');
        if (config.roles.mayor) tPool.push('Mayor');
        if (config.roles.socialite) tPool.push('Socialite');
        if (config.roles.vigilante) tPool.push('Vigilante');
        if (config.roles.agent) tPool.push('Intelligence Agent');
        tPool = shuffle(tPool);

        let finalRoles = [];
        const reqMafia = config.mafiaCount || 1;
        for (let i = 0; i < reqMafia; i++) finalRoles.push(mPool.pop() || 'Mafia');
        for (let i = 0; i < playerIds.length - reqMafia; i++) finalRoles.push(tPool.pop() || 'Villager');
        finalRoles = shuffle(finalRoles);

        activeWeapons = (config.customWeapons && config.customWeapons.trim()) ? config.customWeapons.split(',').map(s => s.trim()).filter(s => s) : DEFAULT_WEAPONS;
        activeLocations = (config.customLocations && config.customLocations.trim()) ? config.customLocations.split(',').map(s => s.trim()).filter(s => s) : DEFAULT_LOCATIONS;

        // Apply AI options from config if provided
        if (config.aiOptions) aiOptions = { ...aiOptions, ...config.aiOptions };

        resetGameState();
        Object.values(players).forEach(p => { p.isAlive = true; p.role = null; p.kicked = false; });

        const mafiaRoom = io.sockets.adapter.rooms.get('mafia_room');
        if (mafiaRoom) {
            for (const sockId of mafiaRoom) {
                const s = io.sockets.sockets.get(sockId);
                if (s) s.leave('mafia_room');
            }
        }

        const mafiaIds = [];
        playerIds.forEach((id, index) => {
            players[id].role = finalRoles[index];
            if (isMafiaTeam(players[id].role)) {
                mafiaIds.push(id);
                io.sockets.sockets.get(players[id].socketId)?.join('mafia_room');
            }
            if (players[id].role === 'Vigilante') vigilanteBullets[id] = 1;
        });

        trueMurderer = mafiaIds[Math.floor(Math.random() * mafiaIds.length)];
        trueWeapon = activeWeapons[Math.floor(Math.random() * activeWeapons.length)];
        trueLocation = activeLocations[Math.floor(Math.random() * activeLocations.length)];

        playerIds.forEach(id => {
            const p = players[id];
            io.to(p.socketId).emit('role_assigned', { displayRole: getDisplayRole(p), coreRole: p.role, playerList: Object.values(players), weapons: activeWeapons, locations: activeLocations });
        });

        if (hostSocketId) {
            io.to(hostSocketId).emit('host_truth', { murdererName: players[trueMurderer]?.name, murdererRole: players[trueMurderer]?.role, weapon: trueWeapon, location: trueLocation });
        }

        global.gameTheme = config.theme;
        roundNumber = 1;
        broadcastGraveyard();
        io.emit('clear_mafia_chat');
        startIntroductionPhase();
    });

    // ------------------------------------------
    // PHASE: INTRODUCTION
    // ------------------------------------------
    async function startIntroductionPhase() {
        gameState = 'INTRO';
        io.emit('phase_change', 'INTRO');
        await narratorBroadcastAndWait('Welcome. Please look at your device now to memorize your secret role.', false);

        const introStory = await getAIStory(global.gameTheme, 'The mystery begins. Briefly establish the setting based on the theme. End by telling everyone to close their eyes. Keep it to 2 or 3 sentences.');
        if (introStory) await narratorBroadcastAndWait(introStory, false);

        phaseEndTime = Date.now() + 5000;
        io.emit('start_intro_timer', 5);

        phaseTimeoutId = setTimeout(async () => {
            await narratorBroadcastAndWait('Everyone, close your eyes. Mafia, open your eyes.', true);

            phaseEndTime = Date.now() + 15000;
            io.emit('start_intro_timer', 15);

            const mafiaRoster = Object.values(players).filter(p => isMafiaTeam(p.role)).map(p => `${p.name} (${getDisplayRole(p)})`).join(', ');
            io.to('mafia_room').emit('open_mafia_intro_chat', { roster: mafiaRoster, time: 15 });

            phaseTimeoutId = setTimeout(async () => {
                io.to('mafia_room').emit('close_mafia_intro_chat');
                await narratorBroadcastAndWait('Mafia, close your eyes. Everyone, open your eyes.', false);
                startInterrogationPhase();
            }, 15000);
        }, 5000);
    }

    // ------------------------------------------
    // PHASE: INTERROGATION
    // ------------------------------------------
    async function startInterrogationPhase() {
        if (roundNumber > gameConfig.maxRounds) return startFinalePhase();
        gameState = 'INTERROGATION';
        io.emit('phase_change', 'INTERROGATION');
        perfectGuessThisRound = false;
        await narratorBroadcastAndWait(`Round ${roundNumber}. The Interrogation Phase begins.`, false);
        interrogationQueue = shuffle(Object.values(players).filter(p => p.isAlive).map(p => p.id));
        nextInterrogationTurn();
    }

    async function nextInterrogationTurn() {
        if (interrogationQueue.length === 0) {
            if (perfectGuessThisRound) {
                perfectGuessThisRound = false;
                await narratorBroadcastAndWait('A stunning revelation — someone in this room has made a perfect deduction. Every piece of the puzzle, correct!', false);
                broadcastGameEvent('🟢', 'A perfect deduction was made this round!', 'success');
            }
            return startDayPhase();
        }
        currentInterrogatorId = interrogationQueue.shift();
        const activeName = players[currentInterrogatorId].name;
        await narratorBroadcastAndWait(`It is now ${activeName}'s turn to interrogate a suspect.`, false);
        const aliveList = Object.values(players).filter(p => p.isAlive).map(p => ({ id: p.id, name: p.name }));
        currentInterrogationState = { activePlayerId: currentInterrogatorId, activePlayerName: activeName, status: 'SELECTING_TARGET', players: aliveList };
        io.emit('interrogation_update', currentInterrogationState);
    }

    socket.on('interrogate_target', (targetId) => {
        const player = getPlayerBySocket(socket.id);
        if (!player || player.id !== currentInterrogatorId || !players[targetId] || !players[targetId].isAlive) return;
        const durationSec = gameConfig.timer;
        phaseEndTime = Date.now() + (durationSec * 1000);
        currentInterrogationState = { activePlayerId: currentInterrogatorId, activePlayerName: player.name, targetName: players[targetId].name, status: 'TICKING', duration: durationSec };
        io.emit('interrogation_update', currentInterrogationState);
        // Feature 6b: Only set timeout if manual progression is off
        if (!aiOptions.manualPhaseProgression) {
            phaseTimeoutId = setTimeout(() => {
                const list = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
                io.to(player.socketId).emit('prompt_clue_guess', { weapons: activeWeapons, locations: activeLocations, playerList: list });
                currentInterrogationState.status = 'GUESSING';
                io.emit('interrogation_update', currentInterrogationState);
            }, durationSec * 1000);
        }
    });

    // Feature 6b: Host manually advances interrogation to guess phase
    socket.on('host_advance_interrogation', () => {
        if (socket.id !== hostSocketId) return;
        if (!aiOptions.manualPhaseProgression || gameState !== 'INTERROGATION') return;
        clearTimeout(phaseTimeoutId);
        if (currentInterrogationState.status === 'TICKING') {
            const list = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
            const activePlayer = players[currentInterrogatorId];
            if (activePlayer) io.to(activePlayer.socketId).emit('prompt_clue_guess', { weapons: activeWeapons, locations: activeLocations, playerList: list });
            currentInterrogationState.status = 'GUESSING';
            io.emit('interrogation_update', currentInterrogationState);
        } else {
            nextInterrogationTurn();
        }
    });

    socket.on('submit_clue_guess', async (guess) => {
        const player = getPlayerBySocket(socket.id);
        if (!player || player.id !== currentInterrogatorId) return;
        if (currentInterrogationState.status !== 'GUESSING') return;
        currentInterrogationState.status = 'RESOLVING';

        let actualScore = (guess.murderer === trueMurderer ? 1 : 0) + (guess.weapon === trueWeapon ? 1 : 0) + (guess.location === trueLocation ? 1 : 0);
        let reportedScore = actualScore;

        if (jammedPlayers.has(player.id)) {
            const fakeScores = [0, 1, 2, 3].filter(s => s !== actualScore);
            reportedScore = fakeScores[Math.floor(Math.random() * fakeScores.length)];
            jammedPlayers.delete(player.id);
        }

        const symbol = reportedScore === 3 ? '🟢' : (reportedScore > 0 ? '⚠️' : '❌');
        io.to(player.socketId).emit('toast_msg', {
            text: `Result: ${symbol}`,
            type: reportedScore === 3 ? 'success' : 'warning',
            notepadText: `\n[Guess] ${players[guess.murderer]?.name}, ${guess.location}, ${guess.weapon} -> ${symbol}`,
            guess, score: reportedScore, symbol
        });

        if (actualScore === 3) perfectGuessThisRound = true;
        await new Promise(res => setTimeout(res, 2000));
        nextInterrogationTurn();
    });

    // ------------------------------------------
    // PHASE: DAY
    // ------------------------------------------
    async function startDayPhase() {
        gameState = 'DAY';
        readyPlayers.clear();
        io.emit('phase_change', 'DAY');
        await narratorBroadcastAndWait(`Town Hall discussion is now open. You have ${gameConfig.dayTimer} seconds.`, false);
        phaseEndTime = Date.now() + (gameConfig.dayTimer * 1000);
        io.emit('start_day_timer', gameConfig.dayTimer);
        if (!aiOptions.manualPhaseProgression) phaseTimeoutId = setTimeout(startDayVoting, gameConfig.dayTimer * 1000);
    }

    async function startDayVoting() {
        gameState = 'DAY_VOTE';
        dayVotes = {};
        io.emit('phase_change', 'DAY_VOTE');
        const voteTimer = gameConfig.voteTimer || 30;
        await narratorBroadcastAndWait(`Discussion ends. You have ${voteTimer} seconds to lock in an execution vote.`, false);
        const aliveList = Object.values(players).filter(p => p.isAlive).map(p => ({ id: p.id, name: p.name }));
        Object.values(players).filter(p => p.isAlive).forEach(p => io.to(p.socketId).emit('prompt_day_vote', aliveList));
        phaseEndTime = Date.now() + (voteTimer * 1000);
        io.emit('start_day_vote_timer', voteTimer);
        if (!aiOptions.manualPhaseProgression) phaseTimeoutId = setTimeout(tallyDayVotes, voteTimer * 1000);
    }

    socket.on('submit_day_vote', (targetId) => {
        const player = getPlayerBySocket(socket.id);
        if (gameState !== 'DAY_VOTE' || !player || !player.isAlive) return;
        dayVotes[player.id] = targetId;
        if (Object.keys(dayVotes).length === Object.values(players).filter(p => p.isAlive).length) {
            clearTimeout(phaseTimeoutId); tallyDayVotes();
        }
    });

    async function tallyDayVotes() {
        if (gameState !== 'DAY_VOTE') return;
        gameState = 'TALLYING';
        let counts = {};

        if (activeVoodooCurse && players[activeVoodooCurse] && players[activeVoodooCurse].isAlive) {
            const cursedVote = dayVotes[activeVoodooCurse];
            if (!cursedVote || cursedVote === 'SKIP') {
                await narratorBroadcastAndWait('A dark curse takes hold... but the cursed soul stays silent. No execution today.', false);
                activeVoodooCurse = null; broadcastGraveyard(); return startNightPhase();
            }
            counts[cursedVote] = 999;
            await narratorBroadcastAndWait('A dark curse takes hold! All voices are silenced except one...', false);
        } else {
            Object.entries(dayVotes).forEach(([pId, target]) => {
                if (target && target !== 'SKIP') counts[target] = (counts[target] || 0) + (players[pId].role === 'Mayor' ? 2 : 1);
            });
        }
        activeVoodooCurse = null;

        let max = 0, accId = null, tie = false;
        for (const [id, c] of Object.entries(counts)) {
            if (c > max) { max = c; accId = id; tie = false; } else if (c === max) tie = true;
        }

        if (tie || !accId) {
            await narratorBroadcastAndWait('The town is deadlocked. No execution takes place.', false);
            logEvent('no_execution', `Round ${roundNumber}: Town was deadlocked.`);
            broadcastGameEvent('🤝', 'The town is deadlocked — no execution today.', 'neutral');
        } else {
            players[accId].isAlive = false;
            let roleReveal = players[accId].role;
            if (roleReveal === 'Mafia') roleReveal = (accId === trueMurderer) ? 'Mafia Murderer' : 'Mafia Accomplice';
            if (gameConfig.blindExecutions) {
                await narratorBroadcastAndWait(`${players[accId].name} was executed by the town. Their true role remains a mystery.`, false);
                broadcastGameEvent('⚖️', `${players[accId].name} was executed. Role hidden.`, 'execution');
            } else {
                await narratorBroadcastAndWait(`${players[accId].name} was executed by the town. They were a ${roleReveal}.`, false);
                broadcastGameEvent('⚖️', `${players[accId].name} was executed — ${roleReveal}.`, 'execution');
            }
            logEvent('execution', `Round ${roundNumber}: ${players[accId].name} was executed. (${roleReveal})`);

            if (isMafiaTeam(players[accId].role)) {
                const cluesToGive = parseInt(gameConfig.cluesPerExecution) || 0;
                if (cluesToGive > 0) await narratorBroadcastAndWait('A search of their belongings revealed secrets...', false);
                for (let i = 0; i < cluesToGive; i++) {
                    const clue = generateUniqueMafiaClue();
                    await narratorBroadcastAndWait(clue, false);
                    broadcastGameEvent('🔎', clue, 'info');
                }
            }
        }
        broadcastGraveyard();
        startNightPhase();
    }

    // ------------------------------------------
    // PHASE: NIGHT
    // ------------------------------------------
    async function startNightPhase() {
        gameState = 'NIGHT';
        jammedPlayers.clear();
        nightActions = { mafiaVotes: {}, lockedMafiaTarget: null, doctorTarget: null, detectiveTarget: null, detectiveSocketId: null, detectivePlayerId: null, framerTarget: null, voodooTarget: null, socialiteTarget: null, vigilanteTarget: null, jammerTarget: null, submissions: new Set() };
        io.emit('phase_change', 'NIGHT');
        await narratorBroadcastAndWait('Night falls. Everyone, close your eyes.', true);

        nightSequence = [];
        if (roleInGame('Socialite')) nightSequence.push('Socialite');
        nightSequence.push('Mafia');
        if (roleInGame('Logic Jammer')) nightSequence.push('Logic Jammer');
        if (roleInGame('Consigliere')) nightSequence.push('Consigliere');
        if (roleInGame('Intelligence Agent')) nightSequence.push('Intelligence Agent');
        if (roleInGame('Framer')) nightSequence.push('Framer');
        if (roleInGame('Voodoo Lady')) nightSequence.push('Voodoo Lady');
        if (roleInGame('Doctor')) nightSequence.push('Doctor');
        if (roleInGame('Detective')) nightSequence.push('Detective');
        const vigPlayer = Object.values(players).find(p => p.role === 'Vigilante' && p.isAlive);
        if (vigPlayer && vigilanteBullets[vigPlayer.id] > 0) nightSequence.push('Vigilante');

        // Feature 6f: Send remaining night roles to host for manual prompting
        if (hostSocketId) io.to(hostSocketId).emit('night_sequence_update', [...nightSequence]);

        // Feature 6b: If manual role prompting, wait for host to trigger each role
        if (aiOptions.manualRolePrompting) {
            // Just emit the sequence — host will trigger via host_wake_role
            return;
        }
        processNextNightTurn();
    }

    async function processNextNightTurn() {
        if (currentNightRole) io.emit('close_night_action');
        if (nightSequence.length === 0) return resolveNight();

        currentNightRole = nightSequence.shift();
        // Feature 6f: Update host with remaining sequence
        if (hostSocketId) io.to(hostSocketId).emit('night_sequence_update', [...nightSequence]);

        const rolePlayers = Object.values(players).filter(p => currentNightRole === 'Mafia' ? isMafiaTeam(p.role) : p.role === currentNightRole);
        const livingRolePlayers = rolePlayers.filter(p => p.isAlive);

        nightActions.submissions = new Set();
        expectedNightSubmissions = livingRolePlayers.length;
        currentNightSubmissions = 0;
        nightTurnActive = true;

        const time = expectedNightSubmissions > 0 ? 30 : Math.floor(Math.random() * 6) + 5;
        const msg = currentNightRole === 'Mafia' ? 'Mafia, open your eyes and select a victim.' : `${currentNightRole}, open your eyes.`;
        await narratorBroadcastAndWait(msg, true);

        nightTimerEndTime = Date.now() + (time * 1000);

        let validTargets = Object.values(players).filter(p => p.isAlive);
        if (currentNightRole === 'Socialite') validTargets = validTargets.filter(p => !livingRolePlayers.some(lp => lp.id === p.id));
        if (currentNightRole === 'Mafia') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));
        if (currentNightRole === 'Voodoo Lady') validTargets = validTargets.filter(p => !isMafiaTeam(p.role));

        livingRolePlayers.forEach(p => {
            io.to(p.socketId).emit('night_action_phase', { role: currentNightRole, time, players: validTargets.map(v => ({ id: v.id, name: v.name })), weapons: activeWeapons, locations: activeLocations });
        });

        nightTimerTimeout = setTimeout(async () => {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            io.emit('close_night_action');
            await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
            await new Promise(res => setTimeout(res, 1000));
            processNextNightTurn();
        }, time * 1000);
    }

    socket.on('submit_night_action', (data) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !p.isAlive) return;
        if (nightActions.submissions.has(p.id)) return;
        nightActions.submissions.add(p.id);

        if (data.role === 'Socialite' && p.role === 'Socialite' && data.targetId !== 'SKIP') nightActions.socialiteTarget = data.targetId;
        if (data.role === 'Logic Jammer' && p.role === 'Logic Jammer' && data.targetId !== 'SKIP') nightActions.jammerTarget = data.targetId;
        if (data.role === 'Framer' && p.role === 'Framer' && data.targetId !== 'SKIP') nightActions.framerTarget = data.targetId;
        if (data.role === 'Voodoo Lady' && p.role === 'Voodoo Lady' && data.targetId !== 'SKIP') nightActions.voodooTarget = data.targetId;

        if (data.role === 'Doctor' && p.role === 'Doctor' && data.targetId !== 'SKIP') {
            if (players[data.targetId] && players[data.targetId].isAlive) nightActions.doctorTarget = data.targetId;
        }

        if ((data.role === 'Consigliere' || data.role === 'Intelligence Agent') && p.role === data.role && data.targetItem !== 'SKIP') {
            const isCorrect = (data.targetItem === trueWeapon || data.targetItem === trueLocation);
            const itemCategory = activeWeapons.includes(data.targetItem) ? 'Weapon' : 'Location';
            io.to(socket.id).emit('toast_msg', { text: isCorrect ? '✅ Intel: TRUE' : '❌ Intel: FALSE', type: isCorrect ? 'success' : 'error', notepadText: `\n[NIGHT] ${itemCategory} "${data.targetItem}" is ${isCorrect ? 'part of the crime' : 'not involved'}.` });
            // Feature 6d: Log intel to live feed
            if (aiOptions.liveActionFeedEnabled) pushLiveFeed(`${p.name} (${p.role}) investigated "${data.targetItem}" → ${isCorrect ? 'TRUE' : 'FALSE'}`);
        }

        if (data.role === 'Detective' && p.role === 'Detective' && data.targetId !== 'SKIP') {
            nightActions.detectiveTarget = data.targetId;
            nightActions.detectiveSocketId = socket.id;
            nightActions.detectivePlayerId = p.id;
            if (aiOptions.liveActionFeedEnabled) pushLiveFeed(`${p.name} (Detective) scanned ${players[data.targetId]?.name}`);
        }

        if (data.role === 'Vigilante' && p.role === 'Vigilante') {
            if (data.targetId !== 'SKIP') {
                nightActions.vigilanteTarget = data.targetId;
                if (aiOptions.liveActionFeedEnabled) pushLiveFeed(`${p.name} (Vigilante) shot ${players[data.targetId]?.name}`);
            }
            vigilanteBullets[p.id] = 0;
        }

        // Feature 6d: Log other role actions
        if (aiOptions.liveActionFeedEnabled) {
            if (data.role === 'Doctor' && data.targetId !== 'SKIP') pushLiveFeed(`${p.name} (Doctor) protected ${players[data.targetId]?.name}`);
            if (data.role === 'Socialite' && data.targetId !== 'SKIP') pushLiveFeed(`${p.name} (Socialite) distracted ${players[data.targetId]?.name}`);
            if (data.role === 'Framer' && data.targetId !== 'SKIP') pushLiveFeed(`${p.name} (Framer) framed ${players[data.targetId]?.name}`);
            if (data.role === 'Logic Jammer' && data.targetId !== 'SKIP') pushLiveFeed(`${p.name} (Logic Jammer) jammed ${players[data.targetId]?.name}`);
            if (data.role === 'Voodoo Lady' && data.targetId !== 'SKIP') pushLiveFeed(`${p.name} (Voodoo Lady) cursed ${players[data.targetId]?.name}`);
        }

        // Feature 6e: Reveal clue board poisoning to host
        if (aiOptions.revealCluePoisoning && data.role === 'Logic Jammer' && data.targetId !== 'SKIP') {
            if (hostSocketId) io.to(hostSocketId).emit('clue_poisoning_update', { jammerName: p.name, targetName: players[data.targetId]?.name, targetId: data.targetId });
        }

        currentNightSubmissions = nightActions.submissions.size;
        if (currentNightSubmissions >= expectedNightSubmissions && expectedNightSubmissions > 0) {
            if (!nightTurnActive) return;
            nightTurnActive = false;
            clearTimeout(nightTimerTimeout);
            (async () => {
                await new Promise(res => setTimeout(res, 4000));
                io.emit('close_night_action');
                await narratorBroadcastAndWait(`${currentNightRole}, close your eyes.`, true);
                await new Promise(res => setTimeout(res, 1000));
                processNextNightTurn();
            })();
        }
    });

    socket.on('mafia_vote', (targetId) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !isMafiaTeam(p.role) || !p.isAlive) return;
        if (!players[targetId] || isMafiaTeam(players[targetId].role)) return;
        nightActions.mafiaVotes[p.id] = targetId;
        if (aiOptions.liveActionFeedEnabled) pushLiveFeed(`${p.name} (Mafia) voted to eliminate ${players[targetId]?.name}`);
        if (Object.keys(nightActions.mafiaVotes).length === expectedNightSubmissions) {
            const targets = [...new Set(Object.values(nightActions.mafiaVotes))];
            if (targets.length === 1) {
                if (!nightTurnActive) return;
                nightTurnActive = false;
                nightActions.lockedMafiaTarget = targets[0];
                clearTimeout(nightTimerTimeout);
                (async () => {
                    await new Promise(res => setTimeout(res, 4000));
                    io.emit('close_night_action');
                    await narratorBroadcastAndWait('Mafia, close your eyes.', true);
                    await new Promise(res => setTimeout(res, 1000));
                    processNextNightTurn();
                })();
            }
        }
    });

    async function resolveNight() {
        currentNightRole = null;
        gameState = 'NIGHT_RESOLVE';

        if (nightActions.jammerTarget) jammedPlayers.add(nightActions.jammerTarget);

        const blockedId = nightActions.socialiteTarget;
        if (blockedId && players[blockedId]) {
            if (isMafiaTeam(players[blockedId].role)) nightActions.lockedMafiaTarget = null;
            if (players[blockedId].role === 'Doctor') nightActions.doctorTarget = null;
            if (players[blockedId].role === 'Framer') nightActions.framerTarget = null;
            if (players[blockedId].role === 'Logic Jammer') jammedPlayers.delete(nightActions.jammerTarget);
            if (players[blockedId].role === 'Voodoo Lady') nightActions.voodooTarget = null;
            if (players[blockedId].role === 'Vigilante') nightActions.vigilanteTarget = null;
            io.to(players[blockedId].socketId).emit('toast_msg', { text: '🍸 Distracted!', type: 'warning', notepadText: '\n[NIGHT] You were distracted by the Socialite! Your night action failed.' });
            logEvent('distracted', `Round ${roundNumber}: ${players[blockedId].name} (${players[blockedId].role}) was distracted.`);
        }

        if (nightActions.detectiveTarget && nightActions.detectiveSocketId) {
            const detTarget = nightActions.detectiveTarget;
            if (nightActions.socialiteTarget !== nightActions.detectivePlayerId) {
                let isEvil = isMafiaTeam(players[detTarget].role);
                if (players[detTarget].role === 'Godfather') isEvil = false;
                if (nightActions.framerTarget === detTarget) isEvil = true;
                const scanResult = `Scan complete: ${players[detTarget].name} is ${isEvil ? 'Mafia' : 'Innocent'}!`;
                io.to(nightActions.detectiveSocketId).emit('toast_msg', { text: `🔍 ${scanResult}`, type: isEvil ? 'error' : 'success', notepadText: `\n[NIGHT] ${players[detTarget].name} scanned as ${isEvil ? 'Mafia' : 'Innocent'}.` });
                io.to(nightActions.detectiveSocketId).emit('game_event', { icon: '🔍', message: scanResult, type: isEvil ? 'danger' : 'success' });
            }
        }

        activeVoodooCurse = nightActions.voodooTarget;
        if (activeVoodooCurse && players[activeVoodooCurse]) {
            io.to(players[activeVoodooCurse].socketId).emit('game_event', { icon: '🔮', message: 'You have been cursed by the Voodoo Lady! Tomorrow only your vote will count.', type: 'danger' });
        }

        const mTarget = nightActions.lockedMafiaTarget;
        const vigTarget = nightActions.vigilanteTarget;
        const diedTonight = [];

        if (mTarget && mTarget !== nightActions.doctorTarget) {
            diedTonight.push(mTarget);
        } else if (mTarget && mTarget === nightActions.doctorTarget) {
            logEvent('saved', `Round ${roundNumber}: ${players[mTarget].name} was targeted by Mafia but saved by the Doctor.`);
            io.to(players[mTarget].socketId).emit('game_event', { icon: '💉', message: 'You were targeted last night but the Doctor saved your life!', type: 'success' });
        }

        if (vigTarget && vigTarget !== nightActions.doctorTarget) {
            if (!diedTonight.includes(vigTarget)) diedTonight.push(vigTarget);
            logEvent('vigilante_kill', `Round ${roundNumber}: ${players[vigTarget].name} was shot by the Vigilante.`);
        } else if (vigTarget && vigTarget === nightActions.doctorTarget) {
            logEvent('saved', `Round ${roundNumber}: ${players[vigTarget].name} was shot by the Vigilante but saved by the Doctor.`);
            io.to(players[vigTarget].socketId).emit('game_event', { icon: '💉', message: 'You were shot by the Vigilante but the Doctor saved your life!', type: 'success' });
        }

        await narratorBroadcastAndWait('Morning comes. Everyone, open your eyes.', false);
        const story = await getAIStory(global.gameTheme, diedTonight.length === 0 ? 'The night was unusually still and quiet. No one was harmed.' : `The group wakes to find ${diedTonight.map(id => players[id].name).join(' and ')} eliminated.`);
        if (story) await narratorBroadcastAndWait(story, false);

        diedTonight.forEach(id => {
            players[id].isAlive = false;
            logEvent('night_kill', `Round ${roundNumber}: ${players[id].name} (${players[id].role}) was eliminated.`);
        });

        if (diedTonight.length > 0) {
            const names = diedTonight.map(id => players[id].name).join(' and ');
            broadcastGameEvent('🌙', `${names} ${diedTonight.length === 1 ? 'was' : 'were'} eliminated during the night.`, 'danger');
        } else {
            broadcastGameEvent('🌙', 'The night passed peacefully — no one was harmed.', 'neutral');
        }

        broadcastGraveyard();
        roundNumber++;
        startInterrogationPhase();
    }

    // ------------------------------------------
    // PHASE: FINALE
    // ------------------------------------------
    async function startFinalePhase() {
        gameState = 'FINALE';
        finaleGuesses = {};
        io.emit('phase_change', 'FINALE');
        await narratorBroadcastAndWait('The time of final judgment is here. Submit your accusations.', false);
        const finalePlayerList = Object.values(players).map(p => ({ id: p.id, name: p.isAlive ? p.name : `👻 ${p.name}` }));
        Object.values(players).filter(p => p.isAlive).forEach(p => {
            io.to(p.socketId).emit('prompt_finale_guess', { weapons: activeWeapons, locations: activeLocations, playerList: finalePlayerList });
        });
    }

    socket.on('submit_finale_guess', async (guess) => {
        const p = getPlayerBySocket(socket.id);
        if (gameState !== 'FINALE' || !p?.isAlive) return;
        finaleGuesses[p.id] = guess;
        if (Object.keys(finaleGuesses).length === Object.values(players).filter(pl => pl.isAlive).length) {
            gameState = 'GAME_OVER';
            io.emit('phase_change', 'GAME_OVER');
            let vWon = false;
            for (const [pId, g] of Object.entries(finaleGuesses)) {
                if (!isMafiaTeam(players[pId].role) && g.murderer === trueMurderer && g.weapon === trueWeapon && g.location === trueLocation) vWon = true;
            }
            const truth = `${players[trueMurderer].name} in the ${trueLocation} with the ${trueWeapon}`;
            await narratorBroadcastAndWait(vWon ? `🟢 VILLAGERS WIN! Truth: ${truth}` : `❌ MAFIA WINS! Truth: ${truth}`, false);
            io.emit('game_recap', {
                winner: vWon ? 'TOWN' : 'MAFIA',
                truth: { murdererName: players[trueMurderer].name, weapon: trueWeapon, location: trueLocation },
                log: gameLog,
                roles: Object.values(players).map(pl => ({ name: pl.name, role: getDisplayRole(pl), isAlive: pl.isAlive }))
            });
        }
    });

    // ------------------------------------------
    // RESET
    // ------------------------------------------
    socket.on('reset_game', () => {
        if (socket.id !== hostSocketId) return;
        resetGameState();
        gameState = 'LOBBY';
        // Reset AI options to defaults on full reset
        aiOptions = { aiNarrationEnabled: true, manualPhaseProgression: false, timerPaused: false, liveActionFeedEnabled: false, revealCluePoisoning: false, manualRolePrompting: false };
        Object.values(players).forEach(p => { p.isAlive = true; p.role = null; p.kicked = false; });
        io.to('mafia_room').emit('close_mafia_intro_chat');
        io.emit('clear_mafia_chat');
        io.emit('phase_change', 'LOBBY');
        io.emit('update_players', Object.values(players));
    });

    socket.on('disconnect', () => {
        if (socket.id === hostSocketId) hostSocketId = null;
        const p = getPlayerBySocket(socket.id);
        if (p && (gameState === 'LOGIN' || gameState === 'LOBBY')) {
            delete players[p.id];
            io.emit('update_players', Object.values(players));
        }
    });
});

server.listen(3000, () => console.log('Mafia x Clue server running...'));
