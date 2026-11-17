package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.JsonText;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.controller.dto.MessageSendRequest;
import com.politeness.ading.conductor.controller.dto.MessageView;
import com.politeness.ading.conductor.controller.dto.ReadRequest;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.service.MessageService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/conversations/{cid}/messages")
public class MessageController {

    private final MessageService messageService;
    private final SenderResolver senderResolver;

    public MessageController(MessageService messageService, SenderResolver senderResolver) {
        this.messageService = messageService;
        this.senderResolver = senderResolver;
    }

    /**
     * People and agents share this one endpoint.
     *
     * Real person: with an access token, the sender is themselves; senderId can also be used to send on behalf of an agent they own.
     * Agent: the desktop sends a node token and uses senderId to specify which owned agent;
     *        the server verifies that this node really owns that agent.
     * With attachments, register and upload via /attachments first; only the attachment_id is sent here.
     */
    @PostMapping
    public Result<MessageView> send(@PathVariable("cid") String conversationId,
                                    @RequestParam(required = false) String senderId,
                                    @Valid @RequestBody MessageSendRequest request) {
        String actualSender = senderResolver.resolve(senderId);
        MessageEntity message = messageService.send(conversationId, actualSender, new MessageService.SendCommand(
                request.messageId(), request.content(), request.type(), request.mentions(), request.replyTo(),
                request.internal(), request.report(), request.failed(), JsonText.of(request.extra()),
                request.attachments()));
        return Result.ok(MessageView.from(message));
    }

    /** Before sending, check whether the content can be sent (banned words), without writing a message. Returns success if it can be sent, MSG_009 if not */
    @PostMapping("/check")
    public Result<Void> check(@PathVariable("cid") String conversationId, @RequestBody ContentCheckRequest request) {
        messageService.checkContent(conversationId, AuthContext.get().userId(), request.content());
        return Result.ok();
    }

    public record ContentCheckRequest(String content) {
    }

    /**
     * after_seq for incremental catch-up / before_seq for history paging; with neither, returns the latest N.
     * The first thing after reconnecting is calling this endpoint - push only speeds things up; pulling is what guarantees correctness.
     */
    @GetMapping
    public Result<List<MessageView>> fetch(@PathVariable("cid") String conversationId,
                                           @RequestParam(required = false) Long afterSeq,
                                           @RequestParam(required = false) Long beforeSeq,
                                           @RequestParam(required = false) Integer limit) {
        String userId = AuthContext.get().userId();
        List<MessageView> views = messageService.fetch(conversationId, userId, afterSeq, beforeSeq, limit)
                .stream().map(MessageView::from).toList();
        return Result.ok(views);
    }

    /** Set the read position. Sending it twice has the same result, hence PUT. */
    @PutMapping("/read")
    public Result<Void> read(@PathVariable("cid") String conversationId,
                             @RequestParam(required = false) String senderId,
                             @Valid @RequestBody ReadRequest request) {
        String userId = senderResolver.resolve(senderId);
        messageService.markRead(conversationId, userId, request.seq());
        return Result.ok();
    }

    /** The Agent's processing watermark, separate from the read position */
    @PutMapping("/processed")
    public Result<Void> processed(@PathVariable("cid") String conversationId,
                                  @RequestParam String senderId,
                                  @Valid @RequestBody ReadRequest request) {
        messageService.markProcessed(conversationId, senderResolver.resolve(senderId), request.seq());
        return Result.ok();
    }

    @PutMapping("/delivered")
    public Result<Void> delivered(@PathVariable("cid") String conversationId,
                                  @RequestParam(required = false) String senderId,
                                  @Valid @RequestBody ReadRequest request) {
        messageService.markDelivered(conversationId, senderResolver.resolve(senderId), request.seq());
        return Result.ok();
    }

    /** Compatibility with old clients: POST is equivalent to PUT */
    @PostMapping("/read")
    public Result<Void> readCompat(@PathVariable("cid") String conversationId,
                                   @RequestParam(required = false) String senderId,
                                   @Valid @RequestBody ReadRequest request) {
        return read(conversationId, senderId, request);
    }
}
