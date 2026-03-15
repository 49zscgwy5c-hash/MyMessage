import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { pool } from './db/mysql';
import { env } from './config/env';
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import conversationsRoutes from './routes/conversations';
import { createMessage } from './services/messages';
import {
  ensureUserInConversation,
  getConversationById,
  getConversationParticipants,
  getUserRoleInConversation,
} from './services/conversations';

const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(
  cors({
    origin: env.clientOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(morgan('dev'));

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/conversations', conversationsRoutes);

const io = new Server(server, {
  cors: {
    origin: env.clientOrigin,
    credentials: true,
  },
});

const onlineUsers = new Map<string, number>();

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

    const payload = jwt.verify(token, env.jwtAccessSecret) as {
      userId: string;
      username: string;
    };

    socket.data.user = payload;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user as { userId: string; username: string };
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

      const allowed = await ensureUserInConversation(user.userId, conversationId);
      if (!allowed) {
        return callback?.({ ok: false, error: 'Forbidden' });
      }

      socket.join(`conversation:${conversationId}`);
      callback?.({ ok: true });
    } catch (error) {
      console.error('conversation:join error', error);
      callback?.({ ok: false, error: 'Internal error' });
    }
  });

  socket.on('typing:start', async (payload) => {
    try {
      const conversationId = String(payload?.conversationId || '');
      if (!conversationId) return;

      const allowed = await ensureUserInConversation(user.userId, conversationId);
      if (!allowed) return;

      socket.to(`conversation:${conversationId}`).emit('typing:update', {
        conversationId,
        userId: user.userId,
        username: user.username,
        isTyping: true,
      });
    } catch (error) {
      console.error('typing:start error', error);
    }
  });

  socket.on('typing:stop', async (payload) => {
    try {
      const conversationId = String(payload?.conversationId || '');
      if (!conversationId) return;

      const allowed = await ensureUserInConversation(user.userId, conversationId);
      if (!allowed) return;

      socket.to(`conversation:${conversationId}`).emit('typing:update', {
        conversationId,
        userId: user.userId,
        username: user.username,
        isTyping: false,
      });
    } catch (error) {
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

      const allowed = await ensureUserInConversation(user.userId, conversationId);
      if (!allowed) {
        return callback?.({ ok: false, error: 'Forbidden' });
      }

      const conversation = await getConversationById(conversationId);
      if (!conversation) {
        return callback?.({ ok: false, error: 'Conversation not found' });
      }

      if (conversation.type === 'channel') {
        const role = await getUserRoleInConversation(user.userId, conversationId);
        if (role !== 'owner' && role !== 'admin') {
          return callback?.({ ok: false, error: 'Only owner/admin can post in channel' });
        }
      }

      const message = await createMessage(
        conversationId,
        user.userId,
        text,
        replyToMessageId
      );

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
      const participants = await getConversationParticipants(conversationId);
      for (const p of participants) {
        io.to(`user:${p.userId}`).emit('conversation:updated', { conversationId });
      }

      callback?.({ ok: true, message });
    } catch (error) {
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
      if (!conversationId) return;

      const allowed = await ensureUserInConversation(user.userId, conversationId);
      if (!allowed) return;

      const readAt = new Date().toISOString();
      const participants = await getConversationParticipants(conversationId);
      for (const p of participants) {
        if (p.userId !== user.userId) {
          io.to(`user:${p.userId}`).emit('message:read', { conversationId, readAt });
        }
      }
    } catch (error) {
      console.error('conversation:read error', error);
    }
  });

  socket.on('disconnect', () => {
    const current = onlineUsers.get(user.userId) || 0;

    if (current <= 1) {
      onlineUsers.delete(user.userId);
    } else {
      onlineUsers.set(user.userId, current - 1);
    }

    broadcastOnlineUsers();
  });
});

console.log('[MyMessage] Server starting...');
console.log('[MyMessage] ✅ Pagination support: enabled (limit/before params)');
console.log('[MyMessage] ✅ Context menu fix: enabled');
console.log('[MyMessage] ✅ UI/UX fixes: enabled');

server.listen(env.port, () => {
  console.log(`[MyMessage] Server running on port ${env.port}`);
});
