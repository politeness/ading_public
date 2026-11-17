package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.common.Result;
import com.politeness.ading.ops.controller.dto.ActiveView;
import com.politeness.ading.ops.controller.dto.DeviceView;
import com.politeness.ading.ops.controller.dto.PageView;
import com.politeness.ading.ops.controller.dto.SummaryView;
import com.politeness.ading.ops.controller.dto.UserView;
import com.politeness.ading.ops.service.OpsStatsService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Ops data queries, all read-only GET. */
@RestController
@RequestMapping("/api")
public class OpsDataController {

    private final OpsStatsService stats;

    public OpsDataController(OpsStatsService stats) {
        this.stats = stats;
    }

    @GetMapping("/summary")
    public Result<SummaryView> summary() {
        return Result.ok(stats.summary());
    }

    @GetMapping("/active")
    public Result<ActiveView> active(@RequestParam(defaultValue = "day") String granularity,
                                     @RequestParam(defaultValue = "30") int days) {
        return Result.ok(stats.active(granularity, days));
    }

    @GetMapping("/active/members")
    public Result<OpsStatsService.ActivityMembers> activeMembers(
            @RequestParam String dimension, @RequestParam String period,
            @RequestParam(defaultValue = "") String bucket,
            @RequestParam(defaultValue = "day") String granularity,
            @RequestParam(defaultValue = "all") String login,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        return Result.ok(stats.activeMembers(dimension, period, bucket, granularity, login, page, size));
    }

    @GetMapping("/users")
    public Result<PageView<UserView>> users(@RequestParam(required = false) String keyword,
                                            @RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int size) {
        return Result.ok(stats.users(keyword, page, size));
    }

    @GetMapping("/agents")
    public Result<PageView<com.politeness.ading.ops.controller.dto.AgentView>> agents(@RequestParam(required = false) String keyword,
                                             @RequestParam(required = false) String owner,
                                             @RequestParam(defaultValue = "false") boolean contact,
                                             @RequestParam(defaultValue = "1") int page,
                                             @RequestParam(defaultValue = "20") int size) {
        return Result.ok(stats.agents(keyword, owner, contact, page, size));
    }

    @GetMapping("/devices")
    public Result<PageView<DeviceView>> devices(@RequestParam(required = false) String keyword,
                                                @RequestParam(defaultValue = "all") String scope,
                                                @RequestParam(required = false) String owner,
                                                @RequestParam(defaultValue = "false") boolean active,
                                                @RequestParam(defaultValue = "1") int page,
                                                @RequestParam(defaultValue = "20") int size) {
        return Result.ok(stats.devices(keyword, scope, owner, active, page, size));
    }
}
