package com.politeness.ading.conductor.controller.dto;

/** held = false means the lock expired or is now held by someone else; stop writing */
public record KnowledgeLockRenewView(boolean held) {
}
