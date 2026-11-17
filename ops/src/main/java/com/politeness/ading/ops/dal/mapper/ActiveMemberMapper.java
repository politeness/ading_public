package com.politeness.ading.ops.dal.mapper;

import com.politeness.ading.ops.dal.ActiveMemberNameRow;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/** Names to show on the activity details page. Who counts as active and for how long is computed by ActivityStats from foreground pings and connections. */
@Mapper
public interface ActiveMemberMapper {

    @Select("""
            <script>
            SELECT user_id AS id, display_name AS name, username FROM users
             WHERE user_id IN <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
            </script>
            """)
    List<ActiveMemberNameRow> userNames(@Param("ids") List<String> ids);

    @Select("""
            <script>
            SELECT device_uuid AS id, name, device_type FROM devices
             WHERE device_uuid IN <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
            </script>
            """)
    List<ActiveMemberNameRow> deviceNames(@Param("ids") List<String> ids);
}
