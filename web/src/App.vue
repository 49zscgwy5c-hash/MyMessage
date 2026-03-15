<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, setToken } from './services/api';
import { connectSocket, disconnectSocket, getSocket } from './services/socket';
import './styles/app.css';

import MainDrawer from './components/MainDrawer.vue';
import SidebarChats from './components/SidebarChats.vue';
import ChatView from './components/ChatView.vue';
import CreateGroupModal from './components/CreateGroupModal.vue';
import CreateChannelModal from './components/CreateChannelModal.vue';
import ChatInfoModal from './components/ChatInfoModal.vue';

type User = {
  id: string;
  username: string;
};

type Conversation = {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string | null;
  createdAt: string;
  lastMessageText: string | null;
  lastMessageCreatedAt: string | null;
  unreadCount: number;
};

type MessageReply = {
  id: string;
  userId: string;
  username: string;
  text: string;
  createdAt: string;
};

type Message = {
  id: string;
  conversationId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: string;
  isRead?: boolean;
  replyTo: MessageReply | null;
};

type Participant = {
  userId: string;
  username: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
};

/**
 * Snapshot of per-conversation message state stored in the in-memory cache.
 * Jump-mode entries are intentionally not restored on revisit so that users
 * always return to the latest messages rather than a stale historical position.
 *
 * Unread state (firstUnreadMessageId / pendingNewMessagesCount) is persisted so
 * that when the user returns to a conversation they had partially read with an
 * active separator, the separator is still visible until they scroll to the
 * bottom (at which point handleReachLatest clears it and marks the chat read).
 */
type ConversationCache = {
  messages: Message[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  isJumpMode: boolean;
  pinnedMessage: Message | null;
  firstUnreadMessageId: string | null;
  pendingNewMessagesCount: number;
};

const MAX_CACHE_SIZE = 10;
const conversationCache = new Map<string, ConversationCache>();
// Per-conversation request token: incremented on each loadMessages call so only
// the latest in-flight response is ever applied (stale-response protection).
const conversationLoadTokens = new Map<string, number>();
// Per-conversation context token: incremented on each openConversation call so
// that any in-flight loadOlderMessages / loadNewerMessages result that was
// started in a previous "session" of the same conversation (i.e. the user
// switched away and switched back) is discarded rather than applied to the
// freshly-opened timeline.
const conversationContextTokens = new Map<string, number>();

const savedToken = localStorage.getItem('token');
const savedUser = localStorage.getItem('currentUser');

const token = ref<string | null>(savedToken);
const currentUser = ref<{ username: string } | null>(savedUser ? JSON.parse(savedUser) : null);

const mode = ref<'auth' | 'app'>(savedToken ? 'app' : 'auth');
const username = ref('');
const password = ref('');
const errorText = ref('');

const users = ref<User[]>([]);
const conversations = ref<Conversation[]>([]);
const activeConversationId = ref<string | null>(null);
const messages = ref<Message[]>([]);
const participants = ref<Participant[]>([]);
const text = ref('');

const loadingOlder = ref(false);
const hasMoreOlder = ref(true);
const hasMoreNewer = ref(false);
const loadingNewer = ref(false);
const isJumpMode = ref(false);
const isChatNearBottom = ref(true);
const pendingNewMessagesCount = ref(0);
// Stable anchor for the unread separator: holds the ID of the first message
// that arrived while the user was away from the bottom.  Using a message ID
// instead of an index-based calculation prevents the separator from drifting
// when older or newer pages are loaded (which change messages.length but not
// the absolute position of the anchor message).
const firstUnreadMessageId = ref<string | null>(null);

const replyToMessage = ref<Message | null>(null);
const pinnedMessage = ref<Message | null>(null);
// Incremented each time the sender's own message arrives via socket so that
// ChatView can watch this value and deterministically scroll to the new message
// regardless of whether wasNearBottom was true or false.
const scrollRevision = ref(0);

const onlineUserIds = ref<string[]>([]);
const typingText = ref('');
let typingTimeout: number | null = null;

const searchQuery = ref('');
const isMenuOpen = ref(false);
const isChatInfoModalOpen = ref(false);
const isCreateGroupModalOpen = ref(false);
const isCreateChannelModalOpen = ref(false);

const groupTitle = ref('');
const selectedGroupUserIds = ref<string[]>([]);
const channelTitle = ref('');

const activeConversation = computed(() =>
  conversations.value.find((item) => item.id === activeConversationId.value) || null
);

const filteredConversations = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return conversations.value;

  return conversations.value.filter((conversation) => {
    const title = (conversation.title || conversation.type || '').toLowerCase();
    const preview = (conversation.lastMessageText || '').toLowerCase();
    return title.includes(q) || preview.includes(q);
  });
});

const myParticipant = computed(() =>
  participants.value.find((p) => p.username === currentUser.value?.username) || null
);

const canSendMessage = computed(() => {
  if (!activeConversation.value) return false;
  if (activeConversation.value.type !== 'channel') return true;
  return myParticipant.value?.role === 'owner' || myParticipant.value?.role === 'admin';
});

const unreadMap = computed(() => {
  return conversations.value.reduce<Record<string, number>>((acc, conversation) => {
    acc[conversation.id] = conversation.unreadCount || 0;
    return acc;
  }, {});
});

function saveSession(nextToken: string, user: { username: string }) {
  token.value = nextToken;
  currentUser.value = user;
  localStorage.setItem('token', nextToken);
  localStorage.setItem('currentUser', JSON.stringify(user));
  setToken(nextToken);
}

function clearSession() {
  token.value = null;
  currentUser.value = null;
  localStorage.removeItem('token');
  localStorage.removeItem('currentUser');
  setToken(null);
}

function toggleGroupUser(userId: string) {
  if (selectedGroupUserIds.value.includes(userId)) {
    selectedGroupUserIds.value = selectedGroupUserIds.value.filter((id) => id !== userId);
  } else {
    selectedGroupUserIds.value = [...selectedGroupUserIds.value, userId];
  }
}

function closeTopOverlay() {
  if (isChatInfoModalOpen.value) {
    isChatInfoModalOpen.value = false;
    return;
  }

  if (isCreateGroupModalOpen.value) {
    isCreateGroupModalOpen.value = false;
    return;
  }

  if (isCreateChannelModalOpen.value) {
    isCreateChannelModalOpen.value = false;
    return;
  }

  if (isMenuOpen.value) {
    isMenuOpen.value = false;
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeTopOverlay();
  }
}

function emitTypingStart() {
  const socket = getSocket();
  if (!socket || !activeConversationId.value) return;

  socket.emit('typing:start', { conversationId: activeConversationId.value });

  if (typingTimeout) {
    window.clearTimeout(typingTimeout);
  }

  typingTimeout = window.setTimeout(() => {
    emitTypingStop();
  }, 1200);
}

function emitTypingStop() {
  const socket = getSocket();
  if (!socket || !activeConversationId.value) return;

  socket.emit('typing:stop', { conversationId: activeConversationId.value });

  if (typingTimeout) {
    window.clearTimeout(typingTimeout);
    typingTimeout = null;
  }
}

watch(text, (value) => {
  if (!activeConversationId.value) return;

  if (value.trim()) {
    emitTypingStart();
  } else {
    emitTypingStop();
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);

  if (typingTimeout) {
    window.clearTimeout(typingTimeout);
    typingTimeout = null;
  }
});

async function register() {
  errorText.value = '';

  try {
    const response = await api.post('/auth/register', {
      username: username.value,
      password: password.value,
    });

    saveSession(response.data.token, { username: response.data.user.username });
    await startApp();
  } catch (error: any) {
    errorText.value = error?.response?.data?.error || error?.message || 'Register error';
  }
}

async function login() {
  errorText.value = '';

  try {
    const response = await api.post('/auth/login', {
      username: username.value,
      password: password.value,
    });

    saveSession(response.data.token, { username: response.data.user.username });
    await startApp();
  } catch (error: any) {
    errorText.value = error?.response?.data?.error || error?.message || 'Login error';
  }
}

async function loadUsers() {
  const response = await api.get('/users');
  users.value = response.data.users;
}

async function loadConversations() {
  const response = await api.get('/conversations');
  conversations.value = response.data.conversations;
}

/**
 * Persist the current message state for `conversationId` into the in-memory
 * cache so it can be restored instantly the next time that conversation is
 * opened.  Uses LRU-style eviction capped at MAX_CACHE_SIZE entries.
 */
function saveConversationToCache(conversationId: string) {
  if (messages.value.length === 0) return;
  // Re-insert to keep insertion-order LRU correct
  conversationCache.delete(conversationId);
  conversationCache.set(conversationId, {
    messages: [...messages.value],
    hasMoreOlder: hasMoreOlder.value,
    hasMoreNewer: hasMoreNewer.value,
    isJumpMode: isJumpMode.value,
    pinnedMessage: pinnedMessage.value,
    firstUnreadMessageId: firstUnreadMessageId.value,
    pendingNewMessagesCount: pendingNewMessagesCount.value,
  });
  if (conversationCache.size > MAX_CACHE_SIZE) {
    // Use a loop in case multiple entries were somehow added beyond the limit.
    while (conversationCache.size > MAX_CACHE_SIZE) {
      const oldest = conversationCache.keys().next().value;
      if (oldest) conversationCache.delete(oldest);
      else break;
    }
  }
}

async function loadMessages(conversationId: string) {
  // Increment the per-conversation request token so any previous in-flight
  // request for this same conversation is invalidated.
  const requestToken = (conversationLoadTokens.get(conversationId) || 0) + 1;
  conversationLoadTokens.set(conversationId, requestToken);

  const response = await api.get(`/conversations/${conversationId}/messages?limit=30`);

  // Guard: active conversation changed while loading
  if (activeConversationId.value !== conversationId) return;
  // Guard: a newer loadMessages call for the same conversation superseded this one
  if (conversationLoadTokens.get(conversationId) !== requestToken) return;

  messages.value = response.data.messages;
  hasMoreOlder.value = !!response.data.hasMoreOlder;
  hasMoreNewer.value = false;
  isJumpMode.value = false;

  // Update cache with fresh data (preserve current pinnedMessage)
  saveConversationToCache(conversationId);
}

async function loadOlderMessages() {
  if (!activeConversationId.value || loadingOlder.value || !hasMoreOlder.value || messages.value.length === 0) {
    return;
  }

  const conversationId = activeConversationId.value;
  // Capture the current context token so we can detect if the user switched
  // away and then back to this conversation while the fetch was in-flight.
  const contextToken = conversationContextTokens.get(conversationId) || 0;
  loadingOlder.value = true;

  try {
    const oldest = messages.value[0];
    const response = await api.get(`/conversations/${conversationId}/messages`, {
      params: {
        limit: 40,
        before: oldest.createdAt,
      },
    });

    // Guard against stale responses: conversation changed OR this conversation
    // was re-opened (context token bumped) while the fetch was in-flight.
    if (activeConversationId.value !== conversationId) return;
    if ((conversationContextTokens.get(conversationId) || 0) !== contextToken) return;

    const older = response.data.messages || [];
    const existingIds = new Set(messages.value.map((m) => m.id));
    const uniqueOlder = older.filter((m: Message) => !existingIds.has(m.id));
    messages.value = [...uniqueOlder, ...messages.value];
    hasMoreOlder.value = !!response.data.hasMoreOlder;
  } finally {
    loadingOlder.value = false;
  }
}

async function loadNewerMessages() {
  if (!activeConversationId.value || loadingNewer.value || !hasMoreNewer.value || messages.value.length === 0) return;

  const conversationId = activeConversationId.value;
  // Capture context token to guard against switch-away/switch-back races.
  const contextToken = conversationContextTokens.get(conversationId) || 0;
  loadingNewer.value = true;
  try {
    const newest = messages.value[messages.value.length - 1];
    const response = await api.get(`/conversations/${conversationId}/messages`, {
      params: { limit: 40, after: newest.createdAt }
    });

    // Guard against stale responses
    if (activeConversationId.value !== conversationId) return;
    if ((conversationContextTokens.get(conversationId) || 0) !== contextToken) return;

    const newer = response.data.messages || [];
    const existingIds = new Set(messages.value.map((m) => m.id));
    const uniqueNewer = newer.filter((m: Message) => !existingIds.has(m.id));
    messages.value = [...messages.value, ...uniqueNewer];
    hasMoreNewer.value = !!response.data.hasMoreNewer;

    if (!hasMoreNewer.value) {
      isJumpMode.value = false;
    }
  } finally {
    loadingNewer.value = false;
  }
}

async function loadParticipants(conversationId: string) {
  const response = await api.get(`/conversations/${conversationId}/participants`);
  participants.value = response.data.participants;
}

async function markConversationRead(conversationId: string) {
  await api.post(`/conversations/${conversationId}/read`);
  // Notify other participants in real-time that this user has read the conversation.
  // The server will broadcast a `message:read` event to the room so that the sender
  // can update the read-receipt (✓✓) on their messages without a full reload.
  const socket = getSocket();
  if (socket) {
    socket.emit('conversation:read', { conversationId });
  }
}

function handleNearBottomChange(value: boolean) {
  isChatNearBottom.value = value;
}

async function handleReachLatest() {
  if (!activeConversationId.value) return;
  if (!isChatNearBottom.value) return;

  // Capture the conversation ID so that the async calls below can be guarded
  // against a conversation switch that might happen while they are in-flight.
  const conversationId = activeConversationId.value;

  // Clear unread state synchronously as part of the "user reached the bottom"
  // transition so the separator and pending-count badge disappear immediately.
  pendingNewMessagesCount.value = 0;
  firstUnreadMessageId.value = null;

  await markConversationRead(conversationId);
  if (activeConversationId.value !== conversationId) return;

  await loadConversations();
  if (activeConversationId.value !== conversationId) return;
}

async function handleJumpToLatest() {
  if (!activeConversationId.value) return;

  const conversationId = activeConversationId.value;

  isJumpMode.value = false;
  hasMoreNewer.value = false;
  isChatNearBottom.value = true;
  pendingNewMessagesCount.value = 0;
  firstUnreadMessageId.value = null;

  await markConversationRead(conversationId);
  if (activeConversationId.value !== conversationId) return;

  await loadConversations();
  if (activeConversationId.value !== conversationId) return;

  await loadMessages(conversationId);
}

function handleReplyToMessage(message: Message) {
  replyToMessage.value = message;
}

function handleClearReply() {
  replyToMessage.value = null;
}

function handlePinMessage(message: Message) {
  pinnedMessage.value = message;
}

async function handleJumpToMessage(messageId: string) {
  if (!messageId || !activeConversationId.value) return;

  const conversationId = activeConversationId.value;
  const contextToken = conversationContextTokens.get(conversationId) || 0;

  // Check if the message is already in the current list
  const existsInList = messages.value.some(m => m.id === messageId);

  if (existsInList) {
    await nextTick();
    const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  // Message not in list — load context around it
  try {
    const response = await api.get(
      `/conversations/${conversationId}/messages/around/${messageId}`,
      { params: { count: 30 } }
    );

    // Guard against stale responses
    if (activeConversationId.value !== conversationId) return;
    if ((conversationContextTokens.get(conversationId) || 0) !== contextToken) return;

    messages.value = response.data.messages || [];
    hasMoreOlder.value = !!response.data.hasMoreOlder;
    hasMoreNewer.value = !!response.data.hasMoreNewer;
    isJumpMode.value = true;

    await nextTick();
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } catch (error) {
    console.error('Failed to jump to message:', error);
  }
}

async function openConversation(conversationId: string) {
  const previousConversationId = activeConversationId.value;

  // Save departing conversation state to cache before clearing it.
  if (previousConversationId && previousConversationId !== conversationId) {
    saveConversationToCache(previousConversationId);
  }

  // Bump the context token for this conversation so any in-flight
  // loadOlderMessages / loadNewerMessages requests from a previous visit
  // are invalidated and will not overwrite the fresh timeline state.
  const newContextToken = (conversationContextTokens.get(conversationId) || 0) + 1;
  conversationContextTokens.set(conversationId, newContextToken);

  activeConversationId.value = conversationId;
  // Explicitly assume the user is at the bottom when opening a conversation.
  // ChatView's conversation-change watcher will call scrollToBottom() which
  // confirms this via notifyBottomState → nearBottomChange.  Setting it here
  // ensures the openConversation guard further below sees the correct value
  // even in the brief window before ChatView's async watcher fires.
  isChatNearBottom.value = true;
  loadingOlder.value = false;
  loadingNewer.value = false;
  typingText.value = '';
  replyToMessage.value = null;

  // Restore cached state immediately for instant display, or start with empty slate.
  // Jump-mode entries are not restored: the user should land at the latest messages.
  const cached = conversationCache.get(conversationId);
  if (cached && !cached.isJumpMode) {
    messages.value = cached.messages;
    hasMoreOlder.value = cached.hasMoreOlder;
    hasMoreNewer.value = cached.hasMoreNewer;
    isJumpMode.value = false;
    pinnedMessage.value = cached.pinnedMessage;
    // Restore unread state only when the anchor message is still present in the
    // cached list.  If the message has since been evicted or the cache is
    // otherwise inconsistent, reset to a clean unread-free state so the user
    // never sees a stale or orphaned separator.
    const anchorPresent =
      cached.firstUnreadMessageId !== null &&
      cached.messages.some((m) => m.id === cached.firstUnreadMessageId);
    firstUnreadMessageId.value = anchorPresent ? cached.firstUnreadMessageId : null;
    pendingNewMessagesCount.value = anchorPresent ? cached.pendingNewMessagesCount : 0;
  } else {
    messages.value = [];
    hasMoreOlder.value = true;
    hasMoreNewer.value = false;
    isJumpMode.value = false;
    pinnedMessage.value = null;
    firstUnreadMessageId.value = null;
    pendingNewMessagesCount.value = 0;
  }

  const socket = getSocket();
  if (socket && previousConversationId && previousConversationId !== conversationId) {
    socket.emit('conversation:leave', { conversationId: previousConversationId });
  }

  // Always fetch fresh messages (background refresh when cache was shown).
  await loadMessages(conversationId);
  if (activeConversationId.value !== conversationId) return;

  // After a fresh load, the cached unread anchor may no longer be present in
  // the new message list (the server returned a different window).  Clear the
  // stale state so the pending-count button and separator stay consistent.
  if (
    firstUnreadMessageId.value !== null &&
    !messages.value.some((m) => m.id === firstUnreadMessageId.value)
  ) {
    firstUnreadMessageId.value = null;
    pendingNewMessagesCount.value = 0;
    // Re-persist the corrected state so a quick switch-away/switch-back does
    // not resurrect the now-invalid anchor.
    saveConversationToCache(conversationId);
  }

  await loadParticipants(conversationId);
  if (activeConversationId.value !== conversationId) return;

  if (isChatNearBottom.value) {
    // User is at the bottom — unread state is no longer meaningful.  Clear it
    // explicitly before marking the conversation read so that the separator and
    // pending count disappear as part of the same synchronous state update.
    pendingNewMessagesCount.value = 0;
    firstUnreadMessageId.value = null;
    await markConversationRead(conversationId);
    if (activeConversationId.value !== conversationId) return;

    await loadConversations();
    if (activeConversationId.value !== conversationId) return;
  }

  socket?.emit('conversation:join', { conversationId }, () => {});
}

async function createDirectConversation(userId: string) {
  try {
    const response = await api.post('/conversations/direct', { userId });
    await loadConversations();
    await openConversation(response.data.id);
  } catch (error: any) {
    errorText.value = error?.response?.data?.error || error?.message || 'Failed to create direct chat';
  }
}

async function createGroup() {
  try {
    if (!groupTitle.value.trim()) {
      errorText.value = 'Название группы обязательно';
      return;
    }

    const response = await api.post('/conversations/group', {
      title: groupTitle.value.trim(),
      participantIds: selectedGroupUserIds.value,
    });

    groupTitle.value = '';
    selectedGroupUserIds.value = [];
    isCreateGroupModalOpen.value = false;

    await loadConversations();
    await openConversation(response.data.id);
  } catch (error: any) {
    errorText.value = error?.response?.data?.error || error?.message || 'Failed to create group';
  }
}

async function createChannel() {
  try {
    if (!channelTitle.value.trim()) {
      errorText.value = 'Название канала обязательно';
      return;
    }

    const response = await api.post('/conversations/channel', {
      title: channelTitle.value.trim(),
    });

    channelTitle.value = '';
    isCreateChannelModalOpen.value = false;

    await loadConversations();
    await openConversation(response.data.id);
  } catch (error: any) {
    errorText.value = error?.response?.data?.error || error?.message || 'Failed to create channel';
  }
}

async function sendMessage() {
  if (!text.value.trim() || !activeConversationId.value) return;

  const socket = getSocket();
  if (!socket) return;

  const conversationId = activeConversationId.value;
  const messageText = text.value.trim();

  isChatNearBottom.value = true;
  pendingNewMessagesCount.value = 0;
  firstUnreadMessageId.value = null;

  socket.emit(
    'message:send',
    {
      conversationId,
      text: messageText,
      replyToMessageId: replyToMessage.value?.id || null,
    },
    async (ack: any) => {
      if (!ack?.ok) {
        errorText.value = ack?.error || 'Message send failed';
        return;
      }

      text.value = '';
      emitTypingStop();
      replyToMessage.value = null;

      if (activeConversationId.value !== conversationId) return;

      await markConversationRead(conversationId);

      if (activeConversationId.value !== conversationId) return;
      await loadConversations();
      // The message:new socket event handles appending the sent message
    }
  );
}

async function startApp() {
  if (!token.value) {
    mode.value = 'auth';
    return;
  }

  try {
    errorText.value = '';
    setToken(token.value);

    mode.value = 'app';

    await loadUsers();
    await loadConversations();

    const socket = connectSocket(token.value);

    socket.off('users:online');
    socket.off('message:new');
    socket.off('message:read');
    socket.off('conversation:updated');
    socket.off('typing:update');

    socket.on('users:online', (payload: { userIds: string[] }) => {
      onlineUserIds.value = payload.userIds || [];
    });

    socket.on('typing:update', (payload: { conversationId: string; username: string; isTyping: boolean }) => {
      if (payload.conversationId !== activeConversationId.value) return;

      if (payload.isTyping) {
        typingText.value = `${payload.username} печатает...`;
      } else {
        typingText.value = '';
      }
    });

    // Realtime read-receipt: update isRead on the current user's messages when
    // another participant marks the conversation as read.
    socket.on('message:read', (payload: { conversationId: string; readAt: string }) => {
      if (payload.conversationId !== activeConversationId.value) return;

      const readAtMs = new Date(payload.readAt).getTime();
      messages.value = messages.value.map((m) => {
        if (m.username === currentUser.value?.username && !m.isRead) {
          if (new Date(m.createdAt).getTime() <= readAtMs) {
            return { ...m, isRead: true };
          }
        }
        return m;
      });
    });

    socket.on('message:new', async (payload: { message: Message }) => {
      const isActiveChatMessage = payload.message.conversationId === activeConversationId.value;
      const isMine = payload.message.username === currentUser.value?.username;

      if (isActiveChatMessage) {
        if (isJumpMode.value) {
          // In jump mode, don't append — user is viewing a historical segment.
          // Track unread count and anchor for messages from others, but don't
          // attempt to place the separator (the anchor message is not in the
          // current list; the separator will be cleared when leaving jump mode).
          if (!isMine) {
            if (firstUnreadMessageId.value === null) {
              firstUnreadMessageId.value = payload.message.id;
            }
            pendingNewMessagesCount.value += 1;
          }
        } else {
          // Append the new message directly to avoid a full list reload
          const alreadyExists = messages.value.some((m) => m.id === payload.message.id);
          if (!alreadyExists) {
            messages.value = [...messages.value, payload.message];
          }

          if (!isMine) {
            if (isChatNearBottom.value) {
              await markConversationRead(payload.message.conversationId);

              if (payload.message.conversationId === activeConversationId.value) {
                pendingNewMessagesCount.value = 0;
                firstUnreadMessageId.value = null;
              }
            } else {
              // Anchor the separator at the first unseen message and increment count.
              if (firstUnreadMessageId.value === null) {
                firstUnreadMessageId.value = payload.message.id;
              }
              pendingNewMessagesCount.value += 1;
            }
          } else {
            // Own message arrived: trigger an explicit scroll to the new message so
            // the sender lands on it regardless of their previous scroll position.
            scrollRevision.value += 1;
          }
        }
      }

      await loadConversations();
    });

    socket.on('conversation:updated', async () => {
      await loadConversations();
    });

    // Do not auto-open any conversation on page load/refresh.
    // The user must explicitly click a conversation in the sidebar.
  } catch (error: any) {
    if (error?.response?.status === 401) {
      logout();
      return;
    }

    errorText.value = error?.response?.data?.error || error?.message || 'Failed to start app';
    mode.value = 'auth';
  }
}

function logout() {
  emitTypingStop();
  clearSession();
  disconnectSocket();

  mode.value = 'auth';
  users.value = [];
  conversations.value = [];
  activeConversationId.value = null;
  messages.value = [];
  participants.value = [];
  text.value = '';
  loadingOlder.value = false;
  hasMoreOlder.value = true;
  hasMoreNewer.value = false;
  loadingNewer.value = false;
  isJumpMode.value = false;
  isChatNearBottom.value = true;
  pendingNewMessagesCount.value = 0;
  firstUnreadMessageId.value = null;
  replyToMessage.value = null;
  pinnedMessage.value = null;
  onlineUserIds.value = [];
  typingText.value = '';
  searchQuery.value = '';
  errorText.value = '';
  groupTitle.value = '';
  selectedGroupUserIds.value = [];
  channelTitle.value = '';
  isMenuOpen.value = false;
  isChatInfoModalOpen.value = false;
  isCreateGroupModalOpen.value = false;
  isCreateChannelModalOpen.value = false;
  conversationCache.clear();
  conversationLoadTokens.clear();
  conversationContextTokens.clear();
}

if (token.value) {
  setToken(token.value);
  startApp().catch((error: any) => {
    if (error?.response?.status === 401) {
      logout();
      return;
    }

    errorText.value = error?.response?.data?.error || error?.message || 'Failed to restore session';
    mode.value = 'auth';
  });
}
</script>

<template>
  <div style="height: 100%;">
    <template v-if="mode === 'auth'">
      <div
        style="
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #17212b, #0e1621);
        "
      >
        <div
          style="
            width: 360px;
            background: #17212b;
            border: 1px solid #22303d;
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,.35);
          "
        >
          <h1 style="margin: 0 0 18px 0; font-size: 28px;">MyMessage</h1>
          <p style="margin: 0 0 18px 0; color: #8ea2b5;">Telegram-like messenger prototype</p>

          <div
            v-if="errorText"
            style="background: #3a1f26; color: #ffb7c5; padding: 10px; margin-bottom: 16px; border-radius: 10px;"
          >
            {{ errorText }}
          </div>

          <div style="display: grid; gap: 12px;">
            <input v-model="username" class="tm-input" placeholder="Username" />
            <input v-model="password" class="tm-input" type="password" placeholder="Password" />

            <div style="display: flex; gap: 10px;">
              <button class="tm-primary" style="flex: 1;" @click="register">Register</button>
              <button class="tm-secondary" style="flex: 1;" @click="login">Login</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="tm-shell tm-shell--wide">
        <SidebarChats
          :users="users"
          :conversations="filteredConversations"
          :active-conversation-id="activeConversationId"
          :search-query="searchQuery"
          :unread-map="unreadMap"
          :online-user-ids="onlineUserIds"
          @menu="isMenuOpen = true"
          @search="searchQuery = $event"
          @open-direct="createDirectConversation"
          @open-conversation="openConversation"
        />

        <ChatView
          :current-username="currentUser?.username || ''"
          :active-conversation="activeConversation"
          :messages="messages"
          :text="text"
          :can-send-message="canSendMessage"
          :typing-text="typingText"
          :loading-older="loadingOlder"
          :has-more-older="hasMoreOlder"
          :has-more-newer="hasMoreNewer"
          :loading-newer="loadingNewer"
          :is-jump-mode="isJumpMode"
          :pending-new-messages-count="pendingNewMessagesCount"
          :first-unread-message-id="firstUnreadMessageId"
          :reply-to-message="replyToMessage"
          :pinned-message="pinnedMessage"
          :scroll-revision="scrollRevision"
          @open-info="isChatInfoModalOpen = true"
          @update-text="text = $event"
          @send="sendMessage"
          @load-older="loadOlderMessages"
          @load-newer="loadNewerMessages"
          @near-bottom-change="handleNearBottomChange"
          @reach-latest="handleReachLatest"
          @jump-to-latest="handleJumpToLatest"
          @reply-to-message="handleReplyToMessage"
          @clear-reply="handleClearReply"
          @pin-message="handlePinMessage"
          @jump-to-message="handleJumpToMessage"
        />
      </div>

      <div
        v-if="isMenuOpen || isChatInfoModalOpen || isCreateGroupModalOpen || isCreateChannelModalOpen"
        class="tm-overlay"
        @click="closeTopOverlay"
      />

      <MainDrawer
        v-if="isMenuOpen"
        :current-username="currentUser?.username || 'User'"
        @close="isMenuOpen = false"
        @create-group="isMenuOpen = false; isCreateGroupModalOpen = true"
        @create-channel="isMenuOpen = false; isCreateChannelModalOpen = true"
        @logout="logout"
      />

      <CreateGroupModal
        v-if="isCreateGroupModalOpen"
        :users="users"
        :title="groupTitle"
        :selected-user-ids="selectedGroupUserIds"
        @close="isCreateGroupModalOpen = false"
        @update-title="groupTitle = $event"
        @toggle-user="toggleGroupUser"
        @submit="createGroup"
      />

      <CreateChannelModal
        v-if="isCreateChannelModalOpen"
        :title="channelTitle"
        @close="isCreateChannelModalOpen = false"
        @update-title="channelTitle = $event"
        @submit="createChannel"
      />

      <ChatInfoModal
        v-if="isChatInfoModalOpen"
        :active-conversation="activeConversation"
        :participants="participants"
        @close="isChatInfoModalOpen = false"
      />
    </template>
  </div>
</template>
