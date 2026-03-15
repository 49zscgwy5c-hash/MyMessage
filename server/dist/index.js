"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const mysql_1 = require("./db/mysql");
const env_1 = require("./config/env");
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const conversations_1 = __importDefault(require("./routes/conversations"));
const messages_1 = require("./services/messages");
const conversations_2 = require("./services/conversations");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: env_1.env.clientOrigin,
    credentials: true,
}));
app.use(express_1.default.json());
app.use((0, morgan_1.default)('dev'));
app.get('/api/health', async (_req, res) => {
    await mysql_1.pool.query('SELECT 1');
    res.json({ ok: true });
});
app.use('/api/auth', auth_1.default);
app.use('/api/users', users_1.default);
app.use('/api/conversations', conversations_1.default);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: env_1.env.clientOrigin,
        credentials: true,
    },
});
const onlineUsers = new Map();
function getOnlineUserIds() {
    return Array.from(onlineUsers.entries())
        .filter(([, count]) => count > 0)
        .map(([userId]) => userId);
}
function broadcastOnlineUsers() {
    io.emit('users:online', { userIds: getOnlineUserIds() });
}
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error('Unauthorized'));
        }
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.jwtAccessSecret);
        socket.data.user = payload;
        next();
    }
    catch {
        next(new Error('Unauthorized'));
    }
});
io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.userId}`);
    const currentCount = onlineUsers.get(user.userId) || 0;
    onlineUsers.set(user.userId, currentCount + 1);
    broadcastOnlineUsers();
    socket.emit('users:online', { userIds: getOnlineUserIds() });
    socket.on('conversation:join', async (payload, callback) => {
        try {
            const conversationId = String(payload?.conversationId || '');
            if (!conversationId) {
                return callback?.({ ok: false, error: 'conversationId required' });
            }
            const allowed = await (0, conversations_2.ensureUserInConversation)(user.userId, conversationId);
            if (!allowed) {
                return callback?.({ ok: false, error: 'Forbidden' });
            }
            socket.join(`conversation:${conversationId}`);
            callback?.({ ok: true });
        }
        catch (error) {
            console.error('conversation:join error', error);
            callback?.({ ok: false, error: 'Internal error' });
        }
    });
    socket.on('typing:start', async (payload) => {
        try {
            const conversationId = String(payload?.conversationId || '');
            if (!conversationId)
                return;
            const allowed = await (0, conversations_2.ensureUserInConversation)(user.userId, conversationId);
            if (!allowed)
                return;
            socket.to(`conversation:${conversationId}`).emit('typing:update', {
                conversationId,
                userId: user.userId,
                username: user.username,
                isTyping: true,
            });
        }
        catch (error) {
            console.error('typing:start error', error);
        }
    });
    socket.on('typing:stop', async (payload) => {
        try {
            const conversationId = String(payload?.conversationId || '');
            if (!conversationId)
                return;
            const allowed = await (0, conversations_2.ensureUserInConversation)(user.userId, conversationId);
            if (!allowed)
                return;
            socket.to(`conversation:${conversationId}`).emit('typing:update', {
                conversationId,
                userId: user.userId,
                username: user.username,
                isTyping: false,
            });
        }
        catch (error) {
            console.error('typing:stop error', error);
        }
    });
    socket.on('message:send', async (payload, callback) => {
        try {
            const conversationId = String(payload?.conversationId || '');
            const text = String(payload?.text || '').trim();
            const replyToMessageId = payload?.replyToMessageId
                ? String(payload.replyToMessageId)
                : null;
            if (!conversationId) {
                return callback?.({ ok: false, error: 'conversationId required' });
            }
            if (!text) {
                return callback?.({ ok: false, error: 'Empty message' });
            }
            const allowed = await (0, conversations_2.ensureUserInConversation)(user.userId, conversationId);
            if (!allowed) {
                return callback?.({ ok: false, error: 'Forbidden' });
            }
            const conversation = await (0, conversations_2.getConversationById)(conversationId);
            if (!conversation) {
                return callback?.({ ok: false, error: 'Conversation not found' });
            }
            if (conversation.type === 'channel') {
                const role = await (0, conversations_2.getUserRoleInConversation)(user.userId, conversationId);
                if (role !== 'owner' && role !== 'admin') {
                    return callback?.({ ok: false, error: 'Only owner/admin can post in channel' });
                }
            }
            const message = await (0, messages_1.createMessage)(conversationId, user.userId, text, replyToMessageId);
            io.to(`conversation:${conversationId}`).emit('message:new', { message });
            io.to(`conversation:${conversationId}`).emit('conversation:updated', {
                conversationId,
            });
            io.to(`conversation:${conversationId}`).emit('typing:update', {
                conversationId,
                userId: user.userId,
                username: user.username,
                isTyping: false,
            });
            // Also notify every participant via their personal user room so that
            // users who are not currently viewing this conversation (and thus are
            // not subscribed to the conversation room) still receive a
            // conversation:updated signal and can refresh their unread counts.
            const participants = await (0, conversations_2.getConversationParticipants)(conversationId);
            for (const p of participants) {
                io.to(`user:${p.userId}`).emit('conversation:updated', { conversationId });
            }
            callback?.({ ok: true, message });
        }
        catch (error) {
            console.error('message:send error', error);
            callback?.({ ok: false, error: 'Internal error' });
        }
    });
    socket.on('conversation:leave', (payload) => {
        const conversationId = String(payload?.conversationId || '');
        if (conversationId) {
            socket.leave(`conversation:${conversationId}`);
        }
    });
    // Emitted by a client after calling POST /conversations/:id/read.
    // Broadcasts a `message:read` event to all other participants via their
    // personal user rooms so that senders can update the read-receipt (✓✓) on
    // their messages in real-time — even when they have navigated away from
    // the conversation (and thus left the conversation socket room).
    socket.on('conversation:read', async (payload) => {
        try {
            const conversationId = String(payload?.conversationId || '');
            if (!conversationId)
                return;
            const allowed = await (0, conversations_2.ensureUserInConversation)(user.userId, conversationId);
            if (!allowed)
                return;
            await (0, conversations_2.markConversationAsRead)(conversationId, user.userId);
            const [rows] = await mysql_1.pool.query(`
        SELECT created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        `, [conversationId]);
            const latestRows = rows;
            const readAt = latestRows[0]?.created_at || new Date().toISOString();
            const participants = await (0, conversations_2.getConversationParticipants)(conversationId);
            for (const p of participants) {
                if (p.userId !== user.userId) {
                    io.to(`user:${p.userId}`).emit('message:read', { conversationId, readAt });
                }
            }
        }
        catch (error) {
            console.error('conversation:read error', error);
        }
    });
    socket.on('message:deleted', async (payload) => {
        try {
            const conversationId = String(payload?.conversationId || '');
            const mode = payload?.mode === 'everyone' ? 'everyone' : 'self';
            const messageIds = Array.isArray(payload?.messageIds)
                ? payload.messageIds.map((id) => String(id || '')).filter(Boolean)
                : [];
            if (!conversationId || messageIds.length === 0)
                return;
            const allowed = await (0, conversations_2.ensureUserInConversation)(user.userId, conversationId);
            if (!allowed)
                return;
            if (mode === 'everyone') {
                io.to(`conversation:${conversationId}`).emit('message:deleted', {
                    conversationId,
                    messageIds,
                    mode,
                    actorUserId: user.userId,
                });
                const participants = await (0, conversations_2.getConversationParticipants)(conversationId);
                for (const p of participants) {
                    io.to(`user:${p.userId}`).emit('conversation:updated', { conversationId });
                }
            }
            else {
                io.to(`user:${user.userId}`).emit('message:deleted', {
                    conversationId,
                    messageIds,
                    mode,
                    actorUserId: user.userId,
                });
                io.to(`user:${user.userId}`).emit('conversation:updated', { conversationId });
            }
        }
        catch (error) {
            console.error('message:deleted error', error);
        }
    });
    socket.on('disconnect', () => {
        const current = onlineUsers.get(user.userId) || 0;
        if (current <= 1) {
            onlineUsers.delete(user.userId);
        }
        else {
            onlineUsers.set(user.userId, current - 1);
        }
        broadcastOnlineUsers();
    });
});
console.log('[MyMessage] Server starting...');
console.log('[MyMessage] ✅ Pagination support: enabled (limit/before params)');
console.log('[MyMessage] ✅ Context menu fix: enabled');
console.log('[MyMessage] ✅ UI/UX fixes: enabled');
server.listen(env_1.env.port, () => {
    console.log(`[MyMessage] Server running on port ${env_1.env.port}`);
});
