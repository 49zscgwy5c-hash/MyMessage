<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type Conversation = {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string | null;
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
  deletedForEveryoneAt?: string | null;
};

type TimelineItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'unread'; key: string; count: number }
  | {
      type: 'message';
      key: string;
      message: Message;
      groupedTop: boolean;
      groupedBottom: boolean;
      mine: boolean;
    };

const props = defineProps<{
  currentUsername: string;
  activeConversation: Conversation | null;
  messages: Message[];
  text: string;
  canSendMessage: boolean;
  typingText: string;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  loadingNewer: boolean;
  isJumpMode: boolean;
  pendingNewMessagesCount: number;
  firstUnreadMessageId: string | null;
  replyToMessage: Message | null;
  pinnedMessage: Message | null;
  scrollRevision: number;
}>();

const emit = defineEmits<{
  openInfo: [];
  updateText: [value: string];
  send: [];
  loadOlder: [];
  loadNewer: [];
  nearBottomChange: [value: boolean];
  reachLatest: [];
  jumpToLatest: [];
  replyToMessage: [message: Message];
  clearReply: [];
  pinMessage: [message: Message];
  jumpToMessage: [messageId: string];
  deleteForSelf: [message: Message];
  deleteForEveryone: [message: Message];
}>();

const messagesEl = ref<HTMLElement | null>(null);
const wasNearBottom = ref(true);
const scrollLockOlder = ref(false);
const scrollLockNewer = ref(false);
const savedScrollHeight = ref(0);
const savedScrollTop = ref(0);

const contextMenu = ref<{
  visible: boolean;
  x: number;
  y: number;
  message: Message | null;
}>({
  visible: false,
  x: 0,
  y: 0,
  message: null,
});

const highlightedMessageId = ref<string | null>(null);
let highlightTimer: number | null = null;

const visibleKeys = ref<Set<string>>(new Set());
let isInitialLoad = true;

function label(conversation: Conversation | null) {
  if (!conversation) return 'Выберите чат';
  return conversation.title || conversation.type;
}

function initials(value: string) {
  return value.trim().slice(0, 2).toUpperCase();
}

function avatarStyle(seed: string) {
  const colors = [
    ['#5dbeff', '#3478f6'],
    ['#67d67c', '#2e9e52'],
    ['#ffb65d', '#f07a2f'],
    ['#ff7aa2', '#d94b78'],
    ['#b18cff', '#7a5af8'],
    ['#66d1c1', '#2c9f90'],
  ];

  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }

  const pair = colors[Math.abs(hash) % colors.length];
  return {
    background: `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`,
  };
}

function authorColor(seed: string) {
  const colors = ['#64b5ff', '#59d46a', '#ffb347', '#ff7fa8', '#b78cff', '#72e6d4'];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sameDay(a: string, b: string) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDayLabel(value: string) {
  const date = new Date(value);
  const now = new Date();

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const current = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

  if (current === today) return 'Сегодня';
  if (current === yesterday) return 'Вчера';

  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
  });
}

function isNearBottom() {
  const el = messagesEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function notifyBottomState() {
  const near = isNearBottom();
  const wasNear = wasNearBottom.value;
  wasNearBottom.value = near;
  emit('nearBottomChange', near);

  // Only emit 'reachLatest' on the transition from not-near → near so that
  // markConversationRead / loadConversations are not called on every scroll
  // event while the user is already at the bottom.
  if (near && !wasNear) emit('reachLatest');
}

function scrollToBottom() {
  const el = messagesEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  notifyBottomState();
}

function onScroll() {
  const el = messagesEl.value;
  if (!el) return;

  notifyBottomState();

  // Load older messages (scroll up).
  // Guard props.messages.length > 0: if the list is empty the lock would get
  // stuck because loadOlderMessages returns early without ever setting
  // loadingOlder = true, so the watcher that resets the lock never fires.
  // Note: savedScrollHeight/savedScrollTop are captured in the loadingOlder
  // watcher (when loading becomes true) so that the snapshot reflects the DOM
  // state AFTER the loading indicator has been rendered, giving a more accurate
  // scroll-position restoration and avoiding scroll jerk.
  if (el.scrollTop < 120 && props.hasMoreOlder && !props.loadingOlder && !scrollLockOlder.value && props.messages.length > 0) {
    scrollLockOlder.value = true;
    emit('loadOlder');
  }

  // Load newer messages (scroll down) — only in jump mode
  if (
    props.isJumpMode &&
    props.hasMoreNewer &&
    !props.loadingNewer &&
    !scrollLockNewer.value &&
    el.scrollHeight - el.scrollTop - el.clientHeight < 150
  ) {
    scrollLockNewer.value = true;
    emit('loadNewer');
  }
}

async function handleJumpToLatest() {
  await nextTick();
  scrollToBottom();
  emit('jumpToLatest');
}

function previewText(value: string) {
  return value.length > 90 ? `${value.slice(0, 90)}…` : value;
}

function hideContextMenu() {
  contextMenu.value.visible = false;
  contextMenu.value.message = null;
}

function openContextMenu(event: MouseEvent, message: Message) {
  event.preventDefault();
  event.stopPropagation();

  const menuW = 220, menuH = 160;
  const x = Math.min(event.clientX, window.innerWidth - menuW - 8);
  const y = Math.min(event.clientY, window.innerHeight - menuH - 8);
  console.log('[ContextMenu] open', { x, y, messageId: message.id });
  contextMenu.value = { visible: true, x, y, message };
}

function handleReply(message: Message) {
  emit('replyToMessage', message);
  hideContextMenu();
}

function handlePin(message: Message) {
  emit('pinMessage', message);
  hideContextMenu();
}

function canDeleteForEveryone(message: Message) {
  return message.username === props.currentUsername && !message.deletedForEveryoneAt;
}

function canDeleteForSelf(message: Message) {
  return !message.deletedForEveryoneAt;
}

function handleDeleteForSelf(message: Message) {
  emit('deleteForSelf', message);
  hideContextMenu();
}

function handleDeleteForEveryone(message: Message) {
  emit('deleteForEveryone', message);
  hideContextMenu();
}

function flashMessage(messageId: string) {
  highlightedMessageId.value = messageId;

  if (highlightTimer) {
    window.clearTimeout(highlightTimer);
  }

  highlightTimer = window.setTimeout(() => {
    highlightedMessageId.value = null;
    highlightTimer = null;
  }, 1800);
}

function jumpToMessageInsideList(messageId: string) {
  const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
  if (!el) return;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashMessage(messageId);
}

function handleJumpToMessage(messageId: string) {
  emit('jumpToMessage', messageId);

  requestAnimationFrame(() => {
    setTimeout(() => {
      jumpToMessageInsideList(messageId);
    }, 120);
  });

  hideContextMenu();
}

function handleGlobalClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest('.tm-context-menu')) {
    hideContextMenu();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') hideContextMenu();
}

// Locate the unread separator by message ID rather than by index arithmetic.
// An arithmetic approach (messages.length - pendingNewMessagesCount) drifts
// whenever messages are prepended (load-older) or appended (load-newer in jump
// mode) because those operations change messages.length while pendingNewMessagesCount
// stays constant.  An ID-based lookup is stable across all pagination operations.
const firstUnreadIndex = computed(() => {
  if (!props.firstUnreadMessageId) return -1;
  return props.messages.findIndex((m) => m.id === props.firstUnreadMessageId);
});

const timeline = computed<TimelineItem[]>(() => {
  const items: TimelineItem[] = [];

  for (let i = 0; i < props.messages.length; i += 1) {
    const msg = props.messages[i];
    const prev = props.messages[i - 1];
    const next = props.messages[i + 1];
    const mine = msg.username === props.currentUsername;

    if (!prev || !sameDay(prev.createdAt, msg.createdAt)) {
      items.push({
        type: 'day',
        key: `day-${msg.id}`,
        label: formatDayLabel(msg.createdAt),
      });
    }

    if (firstUnreadIndex.value >= 0 && i === firstUnreadIndex.value) {
      items.push({
        type: 'unread',
        key: `unread-${msg.id}`,
        count: props.pendingNewMessagesCount,
      });
    }

    const groupedTop =
      !!prev &&
      prev.username === msg.username &&
      sameDay(prev.createdAt, msg.createdAt) &&
      Math.abs(new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 5 * 60 * 1000;

    const groupedBottom =
      !!next &&
      next.username === msg.username &&
      sameDay(next.createdAt, msg.createdAt) &&
      Math.abs(new Date(next.createdAt).getTime() - new Date(msg.createdAt).getTime()) < 5 * 60 * 1000;

    items.push({
      type: 'message',
      key: msg.id,
      message: msg,
      mine,
      groupedTop,
      groupedBottom,
    });
  }

  return items;
});

watch(
  () => props.activeConversation?.id,
  async () => {
    visibleKeys.value = new Set();
    isInitialLoad = true;
    // Always clear scroll-lock state on conversation switch so a lock that was
    // set in the previous session (e.g. via a scroll event on an empty list)
    // cannot bleed into the newly opened conversation.
    scrollLockOlder.value = false;
    scrollLockNewer.value = false;
    savedScrollHeight.value = 0;
    savedScrollTop.value = 0;
    // Reset wasNearBottom to true so that the initial scrollToBottom() below
    // does not trigger a spurious 'reachLatest' emission via the not-near→near
    // transition check in notifyBottomState.  Read marking for the newly opened
    // conversation is handled explicitly by openConversation in App.vue.
    wasNearBottom.value = true;
    hideContextMenu();
    await nextTick();
    scrollToBottom();
  }
);

watch(
  () => props.messages.length,
  async (_newLen, _oldLen) => {
    await nextTick();
    // In jump mode, don't auto-scroll
    if (props.isJumpMode) return;
    // Don't interfere with scroll restoration when loading older messages
    if (scrollLockOlder.value) return;
    if (wasNearBottom.value) {
      scrollToBottom();
    } else {
      notifyBottomState();
    }
  }
);

watch(
  () => props.pendingNewMessagesCount,
  async (value, prev) => {
    // When the pending count resets to zero (e.g. user scrolled to bottom or
    // sent a message), scroll to the bottom so the latest messages are visible.
    // Skip this in jump mode: the user is intentionally viewing a historical
    // segment and jump-to-latest is handled by its own explicit path.
    if (value === 0 && prev > 0 && !props.isJumpMode) {
      await nextTick();
      scrollToBottom();
    }
  }
);

// Scroll to the bottom whenever the sender's own message arrives (scrollRevision
// is incremented in App.vue inside the message:new handler for isMine messages).
// This ensures the sender lands on their newly sent message regardless of whether
// wasNearBottom was true or false at the time of sending.
watch(
  () => props.scrollRevision,
  async (value) => {
    // Guard: value is 0 on initial mount — only act when the revision is actually bumped.
    if (!value) return;
    if (props.isJumpMode) return;
    await nextTick();
    scrollToBottom();
  }
);

watch(
  () => timeline.value,
  async (items) => {
    const newKeys = items.map((i) => i.key).filter((k) => !visibleKeys.value.has(k));
    if (newKeys.length === 0) return;

    if (isInitialLoad || newKeys.length > 1) {
      // Initial chat load, chat switch, or bulk pagination update:
      // show everything immediately with no animation delay.
      isInitialLoad = false;
      const updated = new Set(visibleKeys.value);
      newKeys.forEach((k) => updated.add(k));
      visibleKeys.value = updated;
    } else {
      // Single new message (realtime socket event): reveal on next frame for a smooth fade-in.
      await nextTick();
      requestAnimationFrame(() => {
        const updated = new Set(visibleKeys.value);
        newKeys.forEach((k) => updated.add(k));
        visibleKeys.value = updated;
      });
    }
  },
  { immediate: true }
);

// Manage scroll-position preservation around older-message prepend.
//
// When loadingOlder transitions false → true we snapshot the scroll state
// AFTER the loading indicator has been rendered into the DOM (via nextTick).
// This gives a more accurate baseline than capturing in the scroll handler
// (where the loading indicator has not yet appeared) and eliminates the
// small height discrepancy that was causing visible scroll jerk.
//
// When loadingOlder transitions true → false we restore the scroll position
// using the snapshot, then release the scroll lock.
watch(
  () => props.loadingOlder,
  async (loading, wasLoading) => {
    if (loading && !wasLoading) {
      // Loading just started — wait for Vue to render the loading indicator,
      // then snapshot the scroll state so the restoration calculation is based
      // on the stable DOM that includes that indicator.
      await nextTick();
      const el = messagesEl.value;
      if (el) {
        savedScrollHeight.value = el.scrollHeight;
        savedScrollTop.value = el.scrollTop;
      }
    } else if (!loading && wasLoading) {
      if (savedScrollHeight.value > 0) {
        await nextTick();
        // Correct scroll position synchronously right after Vue's DOM update,
        // before the browser gets a chance to paint.  Using requestAnimationFrame
        // here would defer the correction to the next frame and cause a visible
        // jump because the browser can paint the un-corrected position first.
        if (!messagesEl.value) {
          savedScrollHeight.value = 0;
          savedScrollTop.value = 0;
          scrollLockOlder.value = false;
          return;
        }
        const diff = messagesEl.value.scrollHeight - savedScrollHeight.value;
        messagesEl.value.scrollTop = savedScrollTop.value + diff;
        savedScrollHeight.value = 0;
        savedScrollTop.value = 0;
        scrollLockOlder.value = false;
        notifyBottomState();
      } else {
        scrollLockOlder.value = false;
      }
    }
  }
);

// Release newer-message scroll lock once the fetch completes.
watch(
  () => props.loadingNewer,
  (loading, wasLoading) => {
    if (!loading && wasLoading) {
      scrollLockNewer.value = false;
    }
  }
);

function handleGlobalContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest('.tm-message-shell')) {
    hideContextMenu();
  }
}

onMounted(() => {
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('contextmenu', handleGlobalContextMenu);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleGlobalClick);
  document.removeEventListener('keydown', handleKeydown);
  document.removeEventListener('contextmenu', handleGlobalContextMenu);
  if (highlightTimer) window.clearTimeout(highlightTimer);
});
</script>

<template>
  <main class="tm-chat tm-chat-telegramish">
    <div class="tm-header tm-chat-header">
      <div class="tm-chat-header__left">
        <button class="tm-chat-header__title" @click="emit('openInfo')">
          <div class="tm-avatar">
            {{ initials(label(activeConversation)) }}
          </div>

          <div>
            <div class="tm-chat-header__name">{{ label(activeConversation) }}</div>
            <div class="tm-muted tm-chat-header__meta">
              {{ typingText || activeConversation?.type || 'Telegram-like chat' }}
            </div>
          </div>
        </button>
      </div>

      <div class="tm-chat-header__actions">
        <button class="tm-icon-btn">🔍</button>
        <button class="tm-icon-btn" @click="emit('openInfo')">⋮</button>
      </div>
    </div>

    <button
      v-if="activeConversation && pinnedMessage"
      class="tm-pinned-strip"
      @click="handleJumpToMessage(pinnedMessage.id)"
      title="Перейти к закреплённому сообщению"
    >
      <div class="tm-pinned-strip__title">Закреплённое сообщение</div>
      <div class="tm-pinned-strip__text">
        <span class="tm-pinned-strip__author">{{ pinnedMessage.username }}</span>
        <span>{{ previewText(pinnedMessage.text) }}</span>
      </div>
    </button>

    <div v-else-if="activeConversation" class="tm-pinned-strip tm-pinned-strip--placeholder">
      <div class="tm-pinned-strip__title">Закреплённое сообщение</div>
      <div class="tm-pinned-strip__text">Здесь будет pinned message block, как в Telegram.</div>
    </div>

    <div class="tm-messages-wrap">
      <div ref="messagesEl" class="tm-messages tm-messages-telegramish" @scroll.passive="onScroll">
        <div v-if="loadingOlder" class="tm-muted" style="text-align: center; margin-bottom: 12px;">
          Загрузка старых сообщений...
        </div>

        <div
          v-else-if="hasMoreOlder"
          class="tm-muted"
          style="text-align: center; margin-bottom: 12px;"
        >
          Прокрути вверх для загрузки старых сообщений
        </div>

        <div
          v-else-if="messages.length > 0"
          class="tm-muted"
          style="text-align: center; margin-bottom: 12px; font-size: 12px; color: #6a8399;"
        >
          Начало переписки
        </div>

        <div v-if="!activeConversation" class="tm-empty-chat-state">
          <div class="tm-empty-chat-card">
            <div class="tm-avatar large">M</div>
            <div class="tm-panel-title" style="margin-top: 14px;">MyMessage</div>
            <div class="tm-muted" style="margin-top: 8px;">
              Выбери чат слева или создай новый через меню.
            </div>
          </div>
        </div>

        <template v-for="item in timeline" :key="item.key">
          <div v-if="item.type === 'day'" :class="['tm-day-separator', visibleKeys.has(item.key) ? 'is-visible' : '']">
            <span>{{ item.label }}</span>
          </div>

          <div v-else-if="item.type === 'unread'" :class="['tm-unread-separator', visibleKeys.has(item.key) ? 'is-visible' : '']">
            <div class="tm-unread-separator__line"></div>
            <div class="tm-unread-separator__badge">
              {{ item.count }} новых {{ item.count === 1 ? 'сообщение' : item.count < 5 ? 'сообщения' : 'сообщений' }}
            </div>
            <div class="tm-unread-separator__line"></div>
          </div>

          <div
            v-else
            :data-message-id="item.message.id"
            :class="[
              'tm-message-shell',
              item.mine ? 'mine' : 'other',
              item.groupedTop ? 'grouped-top' : '',
              item.groupedBottom ? 'grouped-bottom' : '',
              highlightedMessageId === item.message.id ? 'is-highlighted' : '',
              visibleKeys.has(item.key) ? 'is-visible' : '',
            ]"
            @contextmenu.prevent.stop="openContextMenu($event, item.message)"
          >
            <div
              v-if="!item.mine"
              class="tm-message-avatar"
              :class="item.groupedTop ? 'is-hidden' : ''"
              :style="avatarStyle(item.message.username)"
            >
              {{ initials(item.message.username) }}
            </div>

            <div
              :class="[
                'tm-message-card',
                item.mine ? 'mine' : 'other',
                item.groupedTop ? 'grouped-top' : '',
                item.groupedBottom ? 'grouped-bottom' : '',
              ]"
            >
              <div
                v-if="!item.groupedTop"
                class="tm-message-author"
                :style="{ color: authorColor(item.message.username) }"
              >
                {{ item.message.username }}
              </div>

              <div
                v-if="item.message.replyTo"
                class="tm-quoted-reply tm-quoted-reply--telegramish"
                @click.stop="handleJumpToMessage(item.message.replyTo.id)"
                title="Перейти к сообщению, на которое отвечают"
              >
                <div class="tm-quoted-reply__bar"></div>
                <div class="tm-quoted-reply__content">
                  <div class="tm-quoted-reply__author">
                    {{ item.message.replyTo.username }}
                  </div>
                  <div class="tm-quoted-reply__text">
                    {{ previewText(item.message.replyTo.text) }}
                  </div>
                </div>
              </div>

              <div
                class="tm-message-text"
                :class="{ 'tm-message-text--deleted': !!item.message.deletedForEveryoneAt }"
              >
                {{ item.message.text }}
              </div>

              <div class="tm-message-meta">
                <template v-if="item.message.replyTo">
                  <span class="tm-reply-inline-icon" title="Ответ">↩</span>
                </template>
                <span>{{ formatTime(item.message.createdAt) }}</span>
                <template v-if="item.mine">
                  <span v-if="item.message.isRead" class="tm-read-mark is-read">✓✓</span>
                  <span v-else class="tm-read-mark">✓</span>
                </template>
              </div>
            </div>
          </div>
        </template>

        <div v-if="loadingNewer" class="tm-muted" style="text-align: center; margin-top: 12px;">
          Загрузка новых сообщений...
        </div>
      </div>
    </div>

    <div class="tm-composer tm-composer-telegramish">
      <div
        v-if="(pendingNewMessagesCount > 0 || isJumpMode) && activeConversation"
        class="tm-new-messages-floating"
      >
        <button class="tm-new-messages-btn" @click="handleJumpToLatest">
          <span v-if="pendingNewMessagesCount > 0">
            ↓ {{ pendingNewMessagesCount }} нов{{ pendingNewMessagesCount === 1 ? 'ое сообщение' : pendingNewMessagesCount < 5 ? 'ых сообщения' : 'ых сообщений' }}
          </span>
          <span v-else>
            ↓ К последним сообщениям
          </span>
        </button>
      </div>

      <div v-if="replyToMessage" class="tm-reply-preview">
        <div class="tm-reply-preview__bar"></div>
        <div class="tm-reply-preview__content">
          <div class="tm-reply-preview__title">Ответ на {{ replyToMessage.username }}</div>
          <div class="tm-reply-preview__text">{{ previewText(replyToMessage.text) }}</div>
        </div>
        <button class="tm-reply-preview__close" @click="emit('clearReply')">✕</button>
      </div>

      <div
        v-if="activeConversation?.type === 'channel' && !canSendMessage"
        style="
          margin-bottom: 10px;
          color: #ffb7c5;
          font-size: 13px;
          padding: 10px 12px;
          background: rgba(58,31,38,.55);
          border: 1px solid rgba(255,107,129,.18);
          border-radius: 12px;
        "
      >
        У тебя только режим чтения: писать в канал могут только owner/admin.
      </div>

      <div class="tm-composer-row tm-composer-row--telegramish">
        <button class="tm-icon-btn" :disabled="!activeConversation || !canSendMessage">📎</button>
        <input
          class="tm-input"
          :value="text"
          @input="emit('updateText', ($event.target as HTMLInputElement).value)"
          @keyup.enter="emit('send')"
          :placeholder="activeConversation?.type === 'channel' && !canSendMessage ? 'Только чтение' : 'Написать сообщение...'"
          :disabled="!activeConversation || !canSendMessage"
        />
        <button class="tm-primary" @click="emit('send')" :disabled="!activeConversation || !canSendMessage">
          ➤
        </button>
      </div>
    </div>

    <div
      v-if="contextMenu.visible && contextMenu.message"
      class="tm-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
      @contextmenu.stop
    >
      <button
        v-if="!contextMenu.message.deletedForEveryoneAt"
        class="tm-context-menu__item"
        @click="handleReply(contextMenu.message)"
      >
        ↩ Ответить
      </button>
      <button
        v-if="!contextMenu.message.deletedForEveryoneAt"
        class="tm-context-menu__item"
        @click="handlePin(contextMenu.message)"
      >
        📌 Закрепить
      </button>
      <button class="tm-context-menu__item" @click="handleJumpToMessage(contextMenu.message.id)">
        🎯 Перейти к сообщению
      </button>
      <button
        v-if="canDeleteForSelf(contextMenu.message)"
        class="tm-context-menu__item"
        @click="handleDeleteForSelf(contextMenu.message)"
      >
        🗑 Удалить у себя
      </button>
      <button
        v-if="canDeleteForEveryone(contextMenu.message)"
        class="tm-context-menu__item"
        @click="handleDeleteForEveryone(contextMenu.message)"
      >
        🚫 Удалить у всех
      </button>
    </div>
  </main>
</template>
