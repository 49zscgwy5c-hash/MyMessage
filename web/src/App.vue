<template>
  <div>
    <!-- Component content -->
  </div>
</template>

<script>
export default {
  methods: {
    socket: {
      on(event, cb) {
        // Socket logic
      }
    },
    // Realtime read-receipt: update isRead on the current user's sent messages when another participant marks the conversation as read.
    'message:read'(data) {
      // handle read receipt logic
    }
  }
}
</script>