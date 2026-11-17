package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.controller.dto.PushDeviceRequest;
import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import com.politeness.ading.conductor.dal.mapper.PushDeviceMapper;
import com.politeness.ading.conductor.error.CommonError;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PushDeviceService {

    private final PushDeviceMapper devices;
    private final NodeService nodes;

    public PushDeviceService(PushDeviceMapper devices, NodeService nodes) {
        this.devices = devices;
        this.nodes = nodes;
    }

    @Transactional
    public void register(String terminalId, String owner, PushDeviceRequest request) {
        if (nodes.requireOwned(terminalId, owner).isExecutionTerminal()) throw new BizException(CommonError.BAD_REQUEST);
        String deviceToken = request.deviceToken().toLowerCase(java.util.Locale.ROOT);
        devices.deleteOtherHolders(deviceToken, terminalId);
        PushDeviceEntity device = new PushDeviceEntity();
        device.setTerminalId(terminalId);
        device.setOwner(owner);
        device.setDeviceToken(deviceToken);
        device.setEnvironment(request.environment());
        device.setLanguage(request.language());
        devices.upsert(device);
    }

    public void unregister(String terminalId) {
        devices.deleteByTerminal(terminalId);
    }
}
