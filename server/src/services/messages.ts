import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/mysql';

export type MessageReplySnippet = {
  id: string;
  userId: string;
  username: string;
  text: string;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: string;
  isRead?: boolean;
  replyTo: MessageReplySnippet | null;
  deletedForEveryoneAt?: string | null;
  forwardedFromMessageId?: string | null;
  forwardedFromUserId?: string | null;
  forwardedFromUsername?: string | null;
};

type MessageRow = {
  id: string;
  conversationId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: string;
  deletedForEveryoneAt: string | null;
  forwardedFromMessageId: string | null;
  forwardedFromUserId: string | null;
  forwardedFromUsername: string | null;
  replyToId: string | null;
  replyToUserId: string | null;
  replyToUsername: string | null;
  replyToText: string | null;
  replyToCreatedAt: string | null;
};

function mapMessageRow(row: MessageRow): ChatMessage {
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
    replyTo:
      isDeletedForEveryone || !row.replyToId
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

export async function createMessage(
  conversationId: string,
  userId: string,
  text: string,
  replyToMessageId?: string | null
): Promise<ChatMessage> {
  const id = uuidv4();

  let validReplyToMessageId: string | null = null;

  if (replyToMessageId) {
    const [replyRows] = await pool.query(
      `
      SELECT id
      FROM messages
      WHERE id = ? AND conversation_id = ?
      LIMIT 1
      `,
      [replyToMessageId, conversationId]
    );

    const replyList = replyRows as Array<{ id: string }>;
    if (replyList[0]) {
      validReplyToMessageId = replyList[0].id;
    }
  }

  await pool.query(
    `
    INSERT INTO messages (id, conversation_id, user_id, text, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?)
    `,
    [id, conversationId, userId, text, validReplyToMessageId]
  );

  const [rows] = await pool.query(
    `
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
    `,
    [id]
  );

  const list = rows as MessageRow[];
  return {
    ...mapMessageRow(list[0]),
    isRead: false,
  };
}


export async function forwardMessages(
  sourceConversationId: string,
  targetConversationId: string,
  currentUserId: string,
  messageIds: string[]
): Promise<ChatMessage[]> {
  if (!messageIds.length) return [];

  const placeholders = messageIds.map(() => '?').join(', ');

  const [rows] = await pool.query(
    `
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
    `,
    [sourceConversationId, ...messageIds, currentUserId]
  );

  const sourceMessages = rows as Array<{
    id: string;
    text: string;
    originalUserId: string;
    originalUsername: string;
  }>;

  const created: ChatMessage[] = [];

  for (const message of sourceMessages) {
    const id = uuidv4();

    await pool.query(
      `
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
      `,
      [
        id,
        targetConversationId,
        currentUserId,
        message.text,
        message.id,
        message.originalUserId,
        message.originalUsername,
      ]
    );

    const [createdRows] = await pool.query(
      `
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
      `,
      [id]
    );

    const list = createdRows as MessageRow[];
    if (list[0]) {
      created.push({
        ...mapMessageRow(list[0]),
        isRead: false,
      });
    }
  }

  return created;
}

export async function getMessagesByConversation(
  conversationId: string,
  currentUserId: string,
  limit = 30,
  beforeCreatedAt?: string,
  afterCreatedAt?: string
): Promise<{ messages: ChatMessage[]; hasMoreOlder: boolean; hasMoreNewer: boolean }> {
  const [conversationRows] = await pool.query(
    `
    SELECT type
    FROM conversations
    WHERE id = ?
    LIMIT 1
    `,
    [conversationId]
  );

  const conversationList = conversationRows as Array<{ type: 'direct' | 'group' | 'channel' }>;
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

  const params: Array<string | number> = [conversationId, currentUserId];
  let hasMoreOlder = false;
  let hasMoreNewer = false;
  let messages: ChatMessage[];

  if (afterCreatedAt) {
    // Load newer messages in ascending order
    let query = baseSelect + ` AND m.created_at > ? ORDER BY m.created_at ASC LIMIT ?`;
    params.push(afterCreatedAt);
    params.push(limit + 1);

    const [rows] = await pool.query(query, params);
    const rawRows = rows as MessageRow[];
    hasMoreNewer = rawRows.length > limit;
    messages = rawRows.slice(0, limit).map(mapMessageRow);
  } else if (beforeCreatedAt) {
    // Load older messages in descending order, then reverse
    let query = baseSelect + ` AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`;
    params.push(beforeCreatedAt);
    params.push(limit + 1);

    const [rows] = await pool.query(query, params);
    const rawRows = rows as MessageRow[];
    hasMoreOlder = rawRows.length > limit;
    messages = rawRows.slice(0, limit).map(mapMessageRow).reverse();
  } else {
    // Load latest messages in descending order, then reverse
    let query = baseSelect + ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const [rows] = await pool.query(query, params);
    const rawRows = rows as MessageRow[];
    hasMoreOlder = rawRows.length > limit;
    hasMoreNewer = false;
    messages = rawRows.slice(0, limit).map(mapMessageRow).reverse();
  }

  const [readRows] = await pool.query(
    `
    SELECT
      cr.user_id AS userId,
      cr.last_read_at AS lastReadAt
    FROM conversation_reads cr
    WHERE cr.conversation_id = ?
    `,
    [conversationId]
  );

  const reads = readRows as Array<{ userId: string; lastReadAt: string | null }>;

  const messagesWithRead = messages.map((message) => {
    if (message.userId !== currentUserId) {
      return { ...message, isRead: false };
    }

    const createdAt = new Date(message.createdAt).getTime();

    const otherReads = reads.filter(
      (item) =>
        item.userId !== currentUserId &&
        item.lastReadAt &&
        new Date(item.lastReadAt).getTime() >= createdAt
    );

    return { ...message, isRead: otherReads.length > 0 };
  });

  return { messages: messagesWithRead, hasMoreOlder, hasMoreNewer };
}

export async function getMessagesAroundId(
  conversationId: string,
  currentUserId: string,
  messageId: string,
  count = 30
): Promise<{ messages: ChatMessage[]; hasMoreOlder: boolean; hasMoreNewer: boolean }> {
  // Get the target message
  const [targetRows] = await pool.query(
    `
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
    `,
    [messageId, conversationId]
  );

  const targetList = targetRows as MessageRow[];
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
  const [olderRows] = await pool.query(
    baseSelect + ` AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`,
    [conversationId, targetCreatedAt, count + 1]
  );
  const olderRaw = olderRows as MessageRow[];
  const hasMoreOlder = olderRaw.length > count;
  const olderMessages = olderRaw.slice(0, count).map(mapMessageRow).reverse();

  // Load messages after target
  const [newerRows] = await pool.query(
    baseSelect + ` AND m.created_at > ? ORDER BY m.created_at ASC LIMIT ?`,
    [conversationId, targetCreatedAt, count + 1]
  );
  const newerRaw = newerRows as MessageRow[];
  const hasMoreNewer = newerRaw.length > count;
  const newerMessages = newerRaw.slice(0, count).map(mapMessageRow);

  const allMessages = [...olderMessages, targetMessage, ...newerMessages];

  // Apply isRead logic
  const [readRows] = await pool.query(
    `
    SELECT
      cr.user_id AS userId,
      cr.last_read_at AS lastReadAt
    FROM conversation_reads cr
    WHERE cr.conversation_id = ?
    `,
    [conversationId]
  );

  const reads = readRows as Array<{ userId: string; lastReadAt: string | null }>;

  const messagesWithRead = allMessages.map((message) => {
    if (message.userId !== currentUserId) {
      return { ...message, isRead: false };
    }

    const createdAt = new Date(message.createdAt).getTime();

    const otherReads = reads.filter(
      (item) =>
        item.userId !== currentUserId &&
        item.lastReadAt &&
        new Date(item.lastReadAt).getTime() >= createdAt
    );

    return { ...message, isRead: otherReads.length > 0 };
  });

  return { messages: messagesWithRead, hasMoreOlder, hasMoreNewer };
}

export async function deleteMessages(
  conversationId: string,
  currentUserId: string,
  messageIds: string[],
  mode: 'self' | 'everyone'
): Promise<{ deletedMessageIds: string[]; mode: 'self' | 'everyone' }> {
  const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { deletedMessageIds: [], mode };
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');

  const [rows] = await pool.query(
    `
    SELECT id, user_id AS userId
    FROM messages
    WHERE conversation_id = ?
      AND id IN (${placeholders})
    `,
    [conversationId, ...uniqueIds]
  );

  const messages = rows as Array<{ id: string; userId: string }>;
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
    await pool.query(
      `
      UPDATE messages
      SET deleted_for_everyone_at = NOW(),
          deleted_for_everyone_by_user_id = ?
      WHERE conversation_id = ?
        AND id IN (${updatePlaceholders})
      `,
      [currentUserId, conversationId, ...existingIds]
    );

    if (existingIds.length > 0) {
      const logValues = existingIds.map(() => '(?, ?, ?, NULL, ?)').join(', ');
      const logParams = existingIds.flatMap((messageId) => [
        messageId,
        conversationId,
        currentUserId,
        mode,
      ]);

      await pool.query(
        `
        INSERT INTO message_deletion_log
          (message_id, conversation_id, actor_user_id, target_user_id, mode)
        VALUES ${logValues}
        `,
        logParams
      );
    }

    return { deletedMessageIds: existingIds, mode };
  }

  const insertValues = existingIds.map(() => '(?, ?)').join(', ');
  const insertParams = existingIds.flatMap((messageId) => [messageId, currentUserId]);

  await pool.query(
    `
    INSERT IGNORE INTO message_hidden_for_users (message_id, user_id)
    VALUES ${insertValues}
    `,
    insertParams
  );

  if (existingIds.length > 0) {
    const logValues = existingIds.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const logParams = existingIds.flatMap((messageId) => [
      messageId,
      conversationId,
      currentUserId,
      currentUserId,
      mode,
    ]);

    await pool.query(
      `
      INSERT INTO message_deletion_log
        (message_id, conversation_id, actor_user_id, target_user_id, mode)
      VALUES ${logValues}
      `,
      logParams
    );
  }

  return { deletedMessageIds: existingIds, mode };
}

