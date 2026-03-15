<script setup lang="ts">
type Conversation = {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string | null;
  createdAt: string;
  lastMessageText: string | null;
  lastMessageCreatedAt: string | null;
  unreadCount: number;
};

const props = defineProps<{
  conversations: Conversation[];
  searchQuery: string;
}>();

const emit = defineEmits<{
  close: [];
  updateSearchQuery: [value: string];
  submit: [conversationId: string];
}>();

function label(conversation: Conversation) {
  return conversation.title || (conversation.type === 'direct' ? 'Личный чат' : conversation.type);
}
</script>

<template>
  <div class="tm-modal tm-forward-modal" @click.stop>
    <div class="tm-modal__header">
      <h3 class="tm-modal__title">Переслать сообщения</h3>
      <button class="tm-modal__close" @click="emit('close')">✕</button>
    </div>

    <input
      class="tm-input"
      type="text"
      placeholder="Поиск чата..."
      :value="props.searchQuery"
      @input="emit('updateSearchQuery', ($event.target as HTMLInputElement).value)"
    />

    <div class="tm-forward-modal__list">
      <button
        v-for="conversation in props.conversations"
        :key="conversation.id"
        class="tm-forward-modal__item"
        @click="emit('submit', conversation.id)"
      >
        <div class="tm-forward-modal__title">
          {{ label(conversation) }}
        </div>
        <div class="tm-forward-modal__meta">
          {{ conversation.type }} · {{ conversation.lastMessageText || 'Без сообщений' }}
        </div>
      </button>

      <div v-if="props.conversations.length === 0" class="tm-forward-modal__empty">
        Нет доступных чатов
      </div>
    </div>
  </div>
</template>
