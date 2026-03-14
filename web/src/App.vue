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

const replyToMessage = ref<Message | null>(null);
const pinnedMessage = ref<Message | null>(null);

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

async function loadMessages(conversationId: string) {
  const response = await api.get(`/conversations/${conversationId}/messages?limit=30`);
  // Guard against stale responses when the active conversation changed while loading
  if (activeConversationId.value !== conversationId) return;
  messages.value = response.data.messages;
  hasMoreOlder.value = !!response.data.hasMoreOlder;
  hasMoreNewer.value = false;
  isJumpMode.value = false;
}

async function loadOlderMessages() {
  if (!activeConversationId.value || loadingOlder.value || !hasMoreOlder.value || messages.value.length === 0) {
    return;
  }

  const conversationId = activeConversationId.value;
  loadingOlder.value = true;

  try {
    const oldest = messages.value[0];
    const response = await api.get(`/conversations/${conversationId}/messages`, {
      params: {
        limit: 40,
        before: oldest.createdAt,
      },
    });

    // Guard against stale responses
    if (activeConversationId.value !== conversationId) return;

    const older = response.data.messages || [];
    messages.value = [...older, ...messages.value];
    hasMoreOlder.value = !!response.data.hasMoreOlder;
  } finally {
    loadingOlder.value = false;
  }
}

async function loadNewerMessages() {
  if (!activeConversationId.value || loadingNewer.value || !hasMoreNewer.value || messages.value.length === 0) return;

  const conversationId = activeConversationId.value;
  loadingNewer.value = true;
  try {
    const newest = messages.value[messages.value.length - 1];
    const response = await api.get(`/conversations/${conversationId}/messages`, {
      params: { limit: 40, after: newest.createdAt }
    });

    // Guard against stale responses
    if (activeConversationId.value !== conversationId) return;

    const newer = response.data.messages || [];
    messages.value = [...messages.value, ...newer];
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
}

function handleNearBottomChange(value: boolean) {
  isChatNearBottom.value = value;
}

async function handleReachLatest() {
  if (!activeConversationId.value) return;
  if (!isChatNearBottom.value) return;

  pendingNewMessagesCount.value = 0;
  await markConversationRead(activeConversationId.value);
  await loadConversations();
  // Messages are kept current via socket events; avoid unnecessary full reload here
}

async function handleJumpToLatest() {
  if (!activeConversationId.value) return;

  isJumpMode.value = false;
  hasMoreNewer.value = false;
  isChatNearBottom.value = true;
  pendingNewMessagesCount.value = 0;

  await markConversationRead(activeConversationId.value);
  await loadConversations();
  await loadMessages(activeConversationId.value);
}

async function refreshActiveConversationMessages() {
  if (!activeConversationId.value) return;
  // In jump mode, don't reload all messages to preserve scroll position
  if (isJumpMode.value) return;
  await loadMessages(activeConversationId.value);
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

  activeConversationId.value = conversationId;
  messages.value = [];
  loadingOlder.value = false;
  hasMoreOlder.value = true;
  hasMoreNewer.value = false;
  loadingNewer.value = false;
  isJumpMode.value = false;
  typingText.value = '';
  pendingNewMessagesCount.value = 0;
  replyToMessage.value = null;
  pinnedMessage.value = null;

  const socket = getSocket();
  if (socket && previousConversationId && previousConversationId !== conversationId) {
    socket.emit('conversation:leave', { conversationId: previousConversationId });
  }

  await loadMessages(conversationId);
  if (activeConversationId.value !== conversationId) return;

  await loadParticipants(conversationId);
  if (activeConversationId.value !== conversationId) return;

  if (isChatNearBottom.value) {
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

    socket.on('message:new', async (payload: { message: Message }) => {
      const isActiveChatMessage = payload.message.conversationId === activeConversationId.value;
      const isMine = payload.message.username === currentUser.value?.username;

      if (isActiveChatMessage) {
        if (isJumpMode.value) {
          // In jump mode, don't append — user is viewing a historical segment.
          // Only track unread count for messages from others.
          if (!isMine) {
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
              }
            } else {
              pendingNewMessagesCount.value += 1;
            }
          }
        }
      }

      await loadConversations();
    });

    socket.on('conversation:updated', async (payload: { conversationId?: string }) => {
      await loadConversations();

      if (payload?.conversationId && payload.conversationId === activeConversationId.value) {
        await refreshActiveConversationMessages();
      }
    });

    if (conversations.value.length > 0) {
      await openConversation(conversations.value[0].id);
    }
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
          :reply-to-message="replyToMessage"
          :pinned-message="pinnedMessage"
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
