package com.politeness.ading.ops.dal;

import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class AttachmentRow {

    private Long id;
    private String ownerType;
    private String ownerId;
    private String kind;
    private String name;
    private String objectKey;
    private String contentType;
    private long sizeBytes;
}
