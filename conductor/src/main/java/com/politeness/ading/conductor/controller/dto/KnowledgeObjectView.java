package com.politeness.ading.conductor.controller.dto;

/** A knowledge object on OSS. etag tells whether it has changed; the client downloads the content itself */
public record KnowledgeObjectView(String name, String etag, long size) {
}
