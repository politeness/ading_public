package com.politeness.ading.conductor.dal.entity;

import lombok.Data;

/** push_devices — APNs device tokens of mobile terminals. One row per phone, belonging only to the currently signed-in account */
@Data
public class PushDeviceEntity {

    public static final String ENV_SANDBOX = "sandbox";
    public static final String ENV_PRODUCTION = "production";

    private String  terminalId;
    private String  owner;
    private String  deviceToken;
    private String  environment;
    private String  language;
}
