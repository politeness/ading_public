package com.politeness.ading.ops.dal;

import lombok.Getter;
import lombok.Setter;

/** Names shown in the activity details: for users the display name and username, for devices the device name and type. */
@Getter
@Setter
public class ActiveMemberNameRow {

    private String id;
    private String name;
    private String username;
    private String deviceType;
}
