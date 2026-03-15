"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMessage = createMessage;
exports.forwardMessages = forwardMessages;
exports.getMessagesByConversation = getMessagesByConversation;
exports.getMessagesAroundId = getMessagesAroundId;
exports.deleteMessages = deleteMessages;
const uuid_1 = require("uuid");
const mysql_1 = require("../db/mysql");
function mapMessageRow(row) {
    const isDeletedForEveryone = !!row.deletedForEveryoneAt;
    return {
        id: row.id,
        conversationId: row.conversationId,
        userId: row.userId,
        username: row.username,
        text: isDeletedForEveryone ? 'Сообщение удалено' : row.text,
        createdAt: row.createdAt,
        deletedForEveryoneAt: row.deletedForEveryoneAt,
        forwardedFromMessageId: row.forwardedFromMessageId || null,
        forwardedFromUserId: row.forwardedFromUserId || null,
        forwardedFromUsername: row.forwardedFromUsername || null,
        replyTo: isDeletedForEveryone || !row.replyToId
            ? null
            : {
                id: row.replyToId,
                userId: row.replyToUserId || '',
                username: row.replyToUsername || 'Unknown',
                text: row.replyToText || '',
                createdAt: row.replyToCreatedAt || row.createdAt,
            },
    };
}
async function createMessage(conversationId, userId, text, replyToMessageId) {
    const id = (0, uuid_1.v4)();
    let validReplyToMessageId = null;
    if (replyToMessageId) {
        const [replyRows] = await mysql_1.pool.query(`
      SELECT id
      FROM messages
      WHERE id = ? AND conversation_id = ?
      LIMIT 1
      `, [replyToMessageId, conversationId]);
        const replyList = replyRows;
        if (replyList[0]) {
            validReplyToMessageId = replyList[0].id;
        }
    }
    await mysql_1.pool.query(`
    INSERT INTO messages (id, conversation_id, user_id, text, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?)
    `, [id, conversationId, userId, text, validReplyToMessageId]);
    const [rows] = await mysql_1.pool.query(`
    SELECT
      m.id,
      m.conversation_id AS conversationId,
      m.user_id AS userId,
      u.username AS username,
      m.text,
      m.created_at AS createdAt,
      m.deleted_for_everyone_at AS deletedForEveryoneAt,
      m.forwarded_from_message_id AS forwardedFromMessageId,
      m.forwarded_from_user_id AS forwardedFromUserId,
      m.forwarded_from_username AS forwardedFromUsername,
      rm.id AS replyToId,
      rm.user_id AS replyToUserId,
      ru.username AS replyToUsername,
      rm.text AS replyToText,
      rm.created_at AS replyToCreatedAt
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    WHERE m.id = ?
    LIMIT 1
    `, [id]);
    const list = rows;
    return {
        ...mapMessageRow(list[0]),
        isRead: false,
    };
}
async function forwardMessages(sourceConversationId, targetConversationId, currentUserId, messageIds) {
    if (!messageIds.length)
        return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    const [rows] = await mysql_1.pool.query(`
    SELECT
      m.id,
      m.text,
      m.user_id AS originalUserId,
      u.username AS originalUsername
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ?
      AND m.id IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1
        FROM message_hidden_for_users mhfu
        WHERE mhfu.message_id = m.id
          AND mhfu.user_id = ?
      )
    ORDER BY m.created_at ASC
    `, [sourceConversationId, ...messageIds, currentUserId]);
    const sourceMessages = rows;
    const created = [];
    for (const message of sourceMessages) {
        const id = (0, uuid_1.v4)();
        await mysql_1.pool.query(`
      INSERT INTO messages (
        id,
        conversation_id,
        user_id,
        text,
        reply_to_message_id,
        forwarded_from_message_id,
        forwarded_from_user_id,
        forwarded_from_username
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      `, [
            id,
            targetConversationId,
            currentUserId,
            message.text,
            message.id,
            message.originalUserId,
            message.originalUsername,
        ]);
        const [createdRows] = await mysql_1.pool.query(`
      SELECT
        m.id,
        m.conversation_id AS conversationId,
        m.user_id AS userId,
        u.username AS username,
        m.text,
        m.created_at AS createdAt,
        m.deleted_for_everyone_at AS deletedForEveryoneAt,
        m.forwarded_from_message_id AS forwardedFromMessageId,
        m.forwarded_from_user_id AS forwardedFromUserId,
        m.forwarded_from_username AS forwardedFromUsername,
        rm.id AS replyToId,
        rm.user_id AS replyToUserId,
        ru.username AS replyToUsername,
        rm.text AS replyToText,
        rm.created_at AS replyToCreatedAt
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
      LEFT JOIN users ru ON ru.id = rm.user_id
      WHERE m.id = ?
      LIMIT 1
      `, [id]);
        const list = createdRows;
        if (list[0]) {
            created.push({
                ...mapMessageRow(list[0]),
                isRead: false,
            });
        }
    }
    return created;
}
async function getMessagesByConversation(conversationId, currentUserId, limit = 30, beforeCreatedAt, afterCreatedAt) {
    const [conversationRows] = await mysql_1.pool.query(`
    SELECT type
    FROM conversations
    WHERE id = ?
    LIMIT 1
    `, [conversationId]);
    const conversationList = conversationRows;
    const conversation = conversationList[0];
    const baseSelect = `
    SELECT
      m.id,
      m.conversation_id AS conversationId,
      m.user_id AS userId,
      u.username AS username,
      m.text,
      m.created_at AS createdAt,
      m.deleted_for_everyone_at AS deletedForEveryoneAt,
      m.forwarded_from_message_id AS forwardedFromMessageId,
      m.forwarded_from_user_id AS forwardedFromUserId,
      m.forwarded_from_username AS forwardedFromUsername,
      rm.id AS replyToId,
      rm.user_id AS replyToUserId,
      ru.username AS replyToUsername,
      rm.text AS replyToText,
      rm.created_at AS replyToCreatedAt
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    WHERE m.conversation_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM message_hidden_for_users mhfu
        WHERE mhfu.message_id = m.id
          AND mhfu.user_id = ?
      )
  `;
    const params = [conversationId, currentUserId];
    let hasMoreOlder = false;
    let hasMoreNewer = false;
    let messages;
    if (afterCreatedAt) {
        // Load newer messages in ascending order
        let query = baseSelect + ` AND m.created_at > ? ORDER BY m.created_at ASC LIMIT ?`;
        params.push(afterCreatedAt);
        params.push(limit + 1);
        const [rows] = await mysql_1.pool.query(query, params);
        const rawRows = rows;
        hasMoreNewer = rawRows.length > limit;
        messages = rawRows.slice(0, limit).map(mapMessageRow);
    }
    else if (beforeCreatedAt) {
        // Load older messages in descending order, then reverse
        let query = baseSelect + ` AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`;
        params.push(beforeCreatedAt);
        params.push(limit + 1);
        const [rows] = await mysql_1.pool.query(query, params);
        const rawRows = rows;
        hasMoreOlder = rawRows.length > limit;
        messages = rawRows.slice(0, limit).map(mapMessageRow).reverse();
    }
    else {
        // Load latest messages in descending order, then reverse
        let query = baseSelect + ` ORDER BY m.created_at DESC LIMIT ?`;
        params.push(limit + 1);
        const [rows] = await mysql_1.pool.query(query, params);
        const rawRows = rows;
        hasMoreOlder = rawRows.length > limit;
        hasMoreNewer = false;
        messages = rawRows.slice(0, limit).map(mapMessageRow).reverse();
    }
    const [readRows] = await mysql_1.pool.query(`
    SELECT
      cr.user_id AS userId,
      cr.last_read_at AS lastReadAt
    FROM conversation_reads cr
    WHERE cr.conversation_id = ?
    `, [conversationId]);
    const reads = readRows;
    const messagesWithRead = messages.map((message) => {
        if (message.userId !== currentUserId) {
            return { ...message, isRead: false };
        }
        const createdAt = new Date(message.createdAt).getTime();
        const otherReads = reads.filter((item) => item.userId !== currentUserId &&
            item.lastReadAt &&
            new Date(item.lastReadAt).getTime() >= createdAt);
        return { ...message, isRead: otherReads.length > 0 };
    });
    return { messages: messagesWithRead, hasMoreOlder, hasMoreNewer };
}
async function getMessagesAroundId(conversationId, currentUserId, messageId, count = 30) {
    // Get the target message
    const [targetRows] = await mysql_1.pool.query(`
    SELECT
      m.id,
      m.conversation_id AS conversationId,
      m.user_id AS userId,
      u.username AS username,
      m.text,
      m.created_at AS createdAt,
      m.deleted_for_everyone_at AS deletedForEveryoneAt,
      rm.id AS replyToId,
      rm.user_id AS replyToUserId,
      ru.username AS replyToUsername,
      rm.text AS replyToText,
      rm.created_at AS replyToCreatedAt
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    WHERE m.id = ? AND m.conversation_id = ?
    LIMIT 1
    `, [messageId, conversationId]);
    const targetList = targetRows;
    if (!targetList[0]) {
        return { messages: [], hasMoreOlder: false, hasMoreNewer: false };
    }
    const targetMessage = mapMessageRow(targetList[0]);
    const targetCreatedAt = targetMessage.createdAt;
    const baseSelect = `
    SELECT
      m.id,
      m.conversation_id AS conversationId,
      m.user_id AS userId,
      u.username AS username,
      m.text,
      m.created_at AS createdAt,
      rm.id AS replyToId,
      rm.user_id AS replyToUserId,
      ru.username AS replyToUsername,
      rm.text AS replyToText,
      rm.created_at AS replyToCreatedAt
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    WHERE m.conversation_id = ?
  `;
    // Load messages before target
    const [olderRows] = await mysql_1.pool.query(baseSelect + ` AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`, [conversationId, targetCreatedAt, count + 1]);
    const olderRaw = olderRows;
    const hasMoreOlder = olderRaw.length > count;
    const olderMessages = olderRaw.slice(0, count).map(mapMessageRow).reverse();
    // Load messages after target
    const [newerRows] = await mysql_1.pool.query(baseSelect + ` AND m.created_at > ? ORDER BY m.created_at ASC LIMIT ?`, [conversationId, targetCreatedAt, count + 1]);
    const newerRaw = newerRows;
    const hasMoreNewer = newerRaw.length > count;
    const newerMessages = newerRaw.slice(0, count).map(mapMessageRow);
    const allMessages = [...olderMessages, targetMessage, ...newerMessages];
    // Apply isRead logic
    const [readRows] = await mysql_1.pool.query(`
    SELECT
      cr.user_id AS userId,
      cr.last_read_at AS lastReadAt
    FROM conversation_reads cr
    WHERE cr.conversation_id = ?
    `, [conversationId]);
    const reads = readRows;
    const messagesWithRead = allMessages.map((message) => {
        if (message.userId !== currentUserId) {
            return { ...message, isRead: false };
        }
        const createdAt = new Date(message.createdAt).getTime();
        const otherReads = reads.filter((item) => item.userId !== currentUserId &&
            item.lastReadAt &&
            new Date(item.lastReadAt).getTime() >= createdAt);
        return { ...message, isRead: otherReads.length > 0 };
    });
    return { messages: messagesWithRead, hasMoreOlder, hasMoreNewer };
}
async function deleteMessages(conversationId, currentUserId, messageIds, mode) {
    const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
        return { deletedMessageIds: [], mode };
    }
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const [rows] = await mysql_1.pool.query(`
    SELECT id, user_id AS userId
    FROM messages
    WHERE conversation_id = ?
      AND id IN (${placeholders})
    `, [conversationId, ...uniqueIds]);
    const messages = rows;
    if (messages.length === 0) {
        return { deletedMessageIds: [], mode };
    }
    const foundIds = new Set(messages.map((m) => m.id));
    const existingIds = uniqueIds.filter((id) => foundIds.has(id));
    if (mode === 'everyone') {
        const hasForeignMessage = messages.some((message) => message.userId !== currentUserId);
        if (hasForeignMessage) {
            throw new Error('FORBIDDEN_DELETE_FOR_EVERYONE');
        }
        const updatePlaceholders = existingIds.map(() => '?').join(', ');
        await mysql_1.pool.query(`
      UPDATE messages
      SET deleted_for_everyone_at = NOW(),
          deleted_for_everyone_by_user_id = ?
      WHERE conversation_id = ?
        AND id IN (${updatePlaceholders})
      `, [currentUserId, conversationId, ...existingIds]);
        if (existingIds.length > 0) {
            const logValues = existingIds.map(() => '(?, ?, ?, NULL, ?)').join(', ');
            const logParams = existingIds.flatMap((messageId) => [
                messageId,
                conversationId,
                currentUserId,
                mode,
            ]);
            await mysql_1.pool.query(`
        INSERT INTO message_deletion_log
          (message_id, conversation_id, actor_user_id, target_user_id, mode)
        VALUES ${logValues}
        `, logParams);
        }
        return { deletedMessageIds: existingIds, mode };
    }
    const insertValues = existingIds.map(() => '(?, ?)').join(', ');
    const insertParams = existingIds.flatMap((messageId) => [messageId, currentUserId]);
    await mysql_1.pool.query(`
    INSERT IGNORE INTO message_hidden_for_users (message_id, user_id)
    VALUES ${insertValues}
    `, insertParams);
    if (existingIds.length > 0) {
        const logValues = existingIds.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const logParams = existingIds.flatMap((messageId) => [
            messageId,
            conversationId,
            currentUserId,
            currentUserId,
            mode,
        ]);
        await mysql_1.pool.query(`
      INSERT INTO message_deletion_log
        (message_id, conversation_id, actor_user_id, target_user_id, mode)
      VALUES ${logValues}
      `, logParams);
    }
    return { deletedMessageIds: existingIds, mode };
}
