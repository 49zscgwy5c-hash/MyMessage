"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const conversations_1 = require("../services/conversations");
const messages_1 = require("../services/messages");
const router = (0, express_1.Router)();
router.get('/', auth_1.requireAuth, async (req, res) => {
    const conversations = await (0, conversations_1.getUserConversations)(req.user.userId);
    return res.json({ conversations });
});
router.post('/direct', auth_1.requireAuth, async (req, res) => {
    const schema = zod_1.z.object({
        userId: zod_1.z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const result = await (0, conversations_1.createDirectConversation)(req.user.userId, parsed.data.userId);
    return res.json(result);
});
router.post('/group', auth_1.requireAuth, async (req, res) => {
    const schema = zod_1.z.object({
        title: zod_1.z.string().min(1).max(255),
        participantIds: zod_1.z.array(zod_1.z.string().min(1)).default([]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const result = await (0, conversations_1.createGroupConversation)(req.user.userId, parsed.data.title, parsed.data.participantIds);
    return res.json(result);
});
router.post('/channel', auth_1.requireAuth, async (req, res) => {
    const schema = zod_1.z.object({
        title: zod_1.z.string().min(1).max(255),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const result = await (0, conversations_1.createChannelConversation)(req.user.userId, parsed.data.title);
    return res.json(result);
});
router.get('/:id/messages/around/:messageId', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    const rawMessageId = req.params.messageId;
    const messageId = Array.isArray(rawMessageId) ? rawMessageId[0] : rawMessageId;
    if (!conversationId || !messageId) {
        return res.status(400).json({ error: 'conversationId and messageId required' });
    }
    const allowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, conversationId);
    if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const countRaw = Array.isArray(req.query.count) ? req.query.count[0] : req.query.count;
    const count = Math.min(Math.max(Number(countRaw || 30), 1), 50);
    const result = await (0, messages_1.getMessagesAroundId)(conversationId, req.user.userId, messageId, count);
    return res.json(result);
});
router.get('/:id/messages', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const allowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, conversationId);
    if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const beforeRaw = Array.isArray(req.query.before) ? req.query.before[0] : req.query.before;
    const afterRaw = Array.isArray(req.query.after) ? req.query.after[0] : req.query.after;
    const limit = Math.min(Math.max(Number(limitRaw || 30), 1), 100);
    const before = beforeRaw ? String(beforeRaw) : undefined;
    const after = afterRaw ? String(afterRaw) : undefined;
    const result = await (0, messages_1.getMessagesByConversation)(conversationId, req.user.userId, limit, before, after);
    return res.json({
        ...result,
        hasMore: result.hasMoreOlder,
    });
});
router.post('/:id/read', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const allowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, conversationId);
    if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    await (0, conversations_1.markConversationAsRead)(conversationId, req.user.userId);
    return res.json({ ok: true });
});
router.post('/:id/messages/forward', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const allowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, conversationId);
    if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const schema = zod_1.z.object({
        targetConversationId: zod_1.z.string().min(1),
        messageIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const targetAllowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, parsed.data.targetConversationId);
    if (!targetAllowed) {
        return res.status(403).json({ error: 'Forbidden target conversation' });
    }
    try {
        const messages = await (0, messages_1.forwardMessages)(conversationId, parsed.data.targetConversationId, req.user.userId, parsed.data.messageIds);
        return res.status(201).json({ ok: true, messages });
    }
    catch (error) {
        console.error('forward messages error', error);
        return res.status(500).json({ error: 'Failed to forward messages' });
    }
});
router.post('/:id/messages/delete', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const allowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, conversationId);
    if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const schema = zod_1.z.object({
        messageIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(100),
        mode: zod_1.z.enum(['self', 'everyone']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    try {
        const result = await (0, messages_1.deleteMessages)(conversationId, req.user.userId, parsed.data.messageIds, parsed.data.mode);
        return res.json({ ok: true, ...result });
    }
    catch (error) {
        if (error?.message === 'FORBIDDEN_DELETE_FOR_EVERYONE') {
            return res.status(403).json({ error: 'You can delete for everyone only your own messages' });
        }
        console.error('delete messages error', error);
        return res.status(500).json({ error: 'Failed to delete messages' });
    }
});
router.get('/:id/participants', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const allowed = await (0, conversations_1.ensureUserInConversation)(req.user.userId, conversationId);
    if (!allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const participants = await (0, conversations_1.getConversationParticipants)(conversationId);
    return res.json({ participants });
});
router.post('/:id/participants', auth_1.requireAuth, async (req, res) => {
    const rawId = req.params.id;
    const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!conversationId) {
        return res.status(400).json({ error: 'conversationId required' });
    }
    const schema = zod_1.z.object({
        userId: zod_1.z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const conversation = await (0, conversations_1.getConversationById)(conversationId);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }
    const requesterRole = await (0, conversations_1.getUserRoleInConversation)(req.user.userId, conversationId);
    if (conversation.type === 'direct') {
        return res.status(400).json({ error: 'Cannot add participants to direct conversation' });
    }
    if (requesterRole !== 'owner' && requesterRole !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    await (0, conversations_1.addParticipantToConversation)(conversationId, parsed.data.userId, 'member');
    return res.json({ ok: true });
});
router.patch('/:id/participants/:userId', auth_1.requireAuth, async (req, res) => {
    const rawConversationId = req.params.id;
    const rawTargetUserId = req.params.userId;
    const conversationId = Array.isArray(rawConversationId) ? rawConversationId[0] : rawConversationId;
    const targetUserId = Array.isArray(rawTargetUserId) ? rawTargetUserId[0] : rawTargetUserId;
    if (!conversationId || !targetUserId) {
        return res.status(400).json({ error: 'Invalid params' });
    }
    const schema = zod_1.z.object({
        role: zod_1.z.enum(['owner', 'admin', 'member']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload' });
    }
    const conversation = await (0, conversations_1.getConversationById)(conversationId);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conversation.type === 'direct') {
        return res.status(400).json({ error: 'Direct conversation has no editable roles' });
    }
    const requesterRole = await (0, conversations_1.getUserRoleInConversation)(req.user.userId, conversationId);
    if (requesterRole !== 'owner') {
        return res.status(403).json({ error: 'Only owner can change roles' });
    }
    await (0, conversations_1.updateParticipantRole)(conversationId, targetUserId, parsed.data.role);
    return res.json({ ok: true });
});
exports.default = router;
