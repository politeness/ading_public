package com.politeness.ading.conductor.controller.dto;

/**
 * Receipt for a contact-the-developer request.
 *
 * @param status sent: reported to the ops console this time; duplicate: the same contactId was already handled and was not written again
 */
public record DeveloperContactResponse(String contactId, String status) {
}
