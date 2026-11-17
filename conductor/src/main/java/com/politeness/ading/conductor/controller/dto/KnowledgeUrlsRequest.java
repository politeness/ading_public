package com.politeness.ading.conductor.controller.dto;

import java.util.List;

/** Objects to get upload, download, or delete URLs for, named relative to the user directory: k_xxx/SKILL.md, m_xxx.json. Upload and delete require the lock token */
public record KnowledgeUrlsRequest(List<String> uploads, List<String> downloads, List<String> deletes, String lockToken) {
}
