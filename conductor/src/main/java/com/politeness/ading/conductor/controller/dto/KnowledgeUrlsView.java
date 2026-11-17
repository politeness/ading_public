package com.politeness.ading.conductor.controller.dto;

import java.util.Map;

/** Object name to time-limited URL. When uploading, Content-Type must match the one given */
public record KnowledgeUrlsView(Map<String, Upload> uploads, Map<String, String> downloads, Map<String, String> deletes) {

    public record Upload(String url, String contentType) {
    }
}
