package com.politeness.ading.conductor.controller.dto;

import java.util.Map;

/**
 * Receipt for an issue report. The desktop writes it into sent/ so the OSS URLs can be opened directly when troubleshooting.
 *
 * @param status        uploaded: actually uploaded this time; duplicate: the same reportId was already uploaded and was not processed again
 * @param objectPrefix  Directory prefix of this report on OSS
 * @param images        Original image file name -> accessible OSS URL
 * @param logs          Original log file name -> accessible OSS URL
 */
public record SupportReportResponse(
        String reportId,
        String status,
        String objectPrefix,
        Map<String, String> images,
        Map<String, String> logs) {
}
