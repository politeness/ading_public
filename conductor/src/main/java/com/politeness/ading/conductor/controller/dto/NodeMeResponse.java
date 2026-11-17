package com.politeness.ading.conductor.controller.dto;

import java.util.List;

public record NodeMeResponse(
        String terminalId,
        String name,
        String status,
        String owner,
        List<UserView> agents) {
}
